// Chat Focus: artifacts and chat files, chat tabs and the new-chat folder, panes, meters, turns, and the live chat's history from the daemon. Split out of controller.mjs's mountShell (F9) with no change in behaviour; names that stay in mountShell come in through outer.
import { artifactView, artifactsIn, KIND_NAMES, chipArtifact } from './artifact.mjs';
import { esc, copy, limitLine, paceOf, paceRow, planWindows, svg, agentImgs, warnHtml, modes, dragBar, LOOSE, IMG_OK, MAX_IMAGES, readImage, imgSrc, agentWarning, toolImages } from './helpers.mjs';
import { pinned, applyCard } from './pinned.mjs';
import { waiting, chip, turnKey, lineDiff } from './composer.mjs';
import { phoneDialogBody } from './phone-link.mjs'; import { LABEL } from './panel.mjs'; import { NOT_USE } from '../../../packages/protocol/index.mjs';

export function installChat(outer) {
const ART = { state: null, mode: 'panel', pins: new Set() }; // pins: chat id + title the user pinned; the agent re-sending it keeps the pin (O27)
const pinKey = art => art.sid + '\n' + art.title;
// The chats on screen in Chat Focus: the pane (two in Split) and a chat modal (an artifact goes with its chat: O28, item 19).
const chatsInView = () => [...(outer.S.split ? outer.S.open.slice(0, 2) : outer.S.open.slice(0, 1)), outer.mdl.open && outer.S.modal?.kind === 'chat' && outer.S.modal.id];
const artSession = () => outer.S.sessions.find(s => s.id === ART.state?.sid);
function artSend(text) {
  const s = artSession();
  if (!canSend(s, text, false)) { outer.toast({ kind: 'comments not sent', txt: 'That chat takes no messages now.', level: 'warn' }, true); return false; }
  const images = s.images; s.images = []; sendText(s, text, false); s.images = images;
  return true;
}
const artOverlay = () => outer.side.body.querySelector(':scope > .art-over');
function keepBox() { // the overlay ends where the side chat's text box starts
  const over = artOverlay(), b = outer.side.body.querySelector('#sideChats .pane .bottom');
  if (over) over.style.bottom = b ? Math.max(0, outer.side.body.getBoundingClientRect().bottom - b.getBoundingClientRect().top) + 'px' : '0px';
}
function openArtifact(art) {
  if (!ART.state || ['kind', 'src', 'sid'].some(k => ART.state.art[k] !== art[k])) ART.state = { art, sid: art.sid };
  ART.mode = ART.pins.has(pinKey(art)) ? 'pinned' : art.mode ?? 'panel';
  const full = { label: 'Full screen', on: () => outer.side.current()?.mode === 'full', go: () => outer.side.current()?.mode === 'full' ? outer.side.back() : outer.side.mode('full') };
  if (outer.S.focus === 'dev' && outer.side.current()?.slot === 'dan-chat') {
    let over = artOverlay(); if (!over) { over = document.createElement('div'); over.className = 'art-over'; outer.side.body.append(over); } over.replaceChildren();
    artifactView(over.appendChild(document.createElement('div')), ART.state, { ...outer.FRAME, send: artSend, modes: [full, { label: 'Close', go: () => over.remove() }] });
    if (ART.mode === 'full') outer.side.mode('full');
    return keepBox();
  }
  const n = art.versions?.length ?? 0, at = n > 1 ? art.versions.findIndex(v => v.src === art.src) : -1, step = d => openArtifact({ ...art, ...art.versions[at + d] });
  // it goes with its chat's focus and, pinned, with its chat (when): hidden elsewhere, back (still pinned) on return
  outer.side.open('artifact', { title: art.title + (at >= 0 ? ` · version ${at + 1} of ${n}` : ''), mode: ART.mode, focuses: [outer.S.focus], defaultWidth: w => w / 2,
    when: () => outer.S.focus !== 'chat' || ART.mode !== 'pinned' || chatsInView().includes(ART.state?.sid),
    render: b => artifactView(b.appendChild(document.createElement('div')), ART.state, { ...outer.FRAME, send: artSend, modes: [
      ...(art.list ? [{ label: 'Back to list', go: () => openChatFiles(art.sid) }] : []), // opened from the chat's list: back to it
      ...(at > 0 ? [{ label: 'Older version', go: () => step(-1) }] : []), ...(at >= 0 && at < n - 1 ? [{ label: 'Newer version', go: () => step(1) }] : []), // O26
      { label: 'Pin', on: () => ART.mode === 'pinned', go: () => { ART.mode = ART.mode === 'pinned' ? 'panel' : 'pinned'; ART.pins[ART.mode === 'pinned' ? 'add' : 'delete'](pinKey(art)); outer.side.mode(ART.mode); } }, full] }),
    onClose: why => { if (why === 'close' && art.list) localStorage.removeItem(cfKey(art.sid)); // its x closes the chat's list too
      if (why !== 'replaced' && outer.chatOn()) outer.side.open('dan-chat', outer.danChat); } }); // Dev Focus gets its chat back (it shows only there)
}
// Plan view: Claude's plan-mode plan (an "Approve Plan" call or approval), or the agent's plan entries, as Markdown.
function openPlan(s, which) {
  const e = s.events[+which], entries = s.events.find(x => x.t === 'plan')?.entries ?? [];
  const src = e?.plan ?? entries.map(([st, t]) => `- [${st === 'completed' ? 'x' : ' '}] ${t}${st === 'in_progress' ? ' *(in progress)*' : ''}`).join('\n');
  openArtifact({ kind: 'markdown', lang: 'md', mode: 'panel', title: 'Plan', src, sid: s.id });
}
// A turn ended: the newest artifact of its reply opens by itself when that chat is on screen (else its chip waits).
function autoArtifact(s) {
  const from = s.events.findLastIndex(e => e.t === 'user') + 1, found = [];
  for (const e of s.events.slice(from)) if (e.t === 'agent' && !e.artSeen) { e.artSeen = true; found.push(...artifactsIn(e.text)); }
  const onScreen = outer.S.focus === 'chat' ? (outer.S.split ? outer.S.open.slice(0, 2) : outer.S.open.slice(0, 1)).includes(s.id) : outer.S.focus === 'dev' && outer.sideSession()?.id === s.id;
  if (found.length && onScreen) openArtifact({ ...found.at(-1), sid: s.id });
}
// Chat files (the request, 2026-10-30: "a button just to the left of the running indicator that will open a side pannel and show me
// the artifacts and files and such? just like anthropic does"). The button sits left of the chat's own Running label (pane());
// its panel, the side panel's 'chat-files' slot, has two tabs (Builder, 2026-11-02: "separate the artifacts from the diffs into
// their own tabs"), each newest first. Artifacts: every artifact the chat's replies posted (a click opens it as its chip does).
// Changes: every file its finished edit calls wrote (editFiles), created or edited; a click shows that file's diffs, read-only
// ("let me at lease read only the diff"), from the edit calls themselves, so nothing is read from the disk and nothing can be
// applied. The open list and its tab are remembered per chat (localStorage 'p9-chat-files:<id>'): that chat shown again in
// Chat Focus opens it again.
// ponytail: only the chat's loaded events are read (its latest TAIL steps until Show earlier), as the chat itself shows them;
// artifacts are the exception (keptArts, below).
const CF = { sid: null, ws: null, asked: false, html: null, tab: 'artifacts' };
const cfKey = id => 'p9-chat-files:' + id;
// Artifacts outlive the loaded events (Builder, 2026-11-02: "the artifacts are lost on compact"): a chat long enough to compact
// loads only its newest TAIL steps after a reload, and its older artifacts fell out of the list. Every artifact a chat's loaded
// replies hold is kept for that chat (localStorage 'p9-artifacts:<id>') and listed after the loaded ones.
// ponytail: this window's storage only, the newest 30 per chat; an artifact this window never loaded shows once Show earlier reaches it.
const artKey = id => 'p9-artifacts:' + id;
const artSig = a => a.sig ??= JSON.stringify([a.kind, a.lang, a.title, a.src]);
const keptArts = s => s.keptArts ??= (() => { try { const a = JSON.parse(localStorage.getItem(artKey(s.id))); return Array.isArray(a) ? a.filter(x => typeof x?.src === 'string' && KIND_NAMES[x.kind]) : []; } catch { return []; } })();
function chatItems(s) {
  const out = [], seen = new Map(), loaded = new Set();
  s.events.forEach((e, i) => {
    if (e.t === 'agent' && e.text?.includes('artifact')) { if (e.artText !== e.text) { e.artText = e.text; e.arts = artifactsIn(e.text); } for (const art of e.arts) { out.push({ type: 'artifact', at: i, art }); loaded.add(artSig(art)); } }
    else if (e.t === 'tool' && e.files && e.status === 'completed') for (const f of e.files) {
      const was = seen.get(f.path), item = { type: 'file', at: i, path: f.path, created: f.created || !!was?.created };
      if (was) out.splice(out.indexOf(was), 1); // one row per file, at its newest write
      seen.set(f.path, item); out.push(item);
    }
  });
  const kept = keptArts(s), known = new Set(kept.map(artSig)), fresh = out.filter(it => it.type === 'artifact' && !known.has(artSig(it.art)));
  if (fresh.length) {
    kept.push(...fresh.map(({ art: { kind, lang, mode, title, src } }) => ({ kind, lang, mode, title, src })));
    kept.splice(0, Math.max(0, kept.length - 30));
    try { localStorage.setItem(artKey(s.id), JSON.stringify(kept)); } catch {} // full storage: listed while loaded, as before
  }
  out.unshift(...kept.filter(a => !loaded.has(artSig(a))).map(art => ({ type: 'artifact', at: -1, art })));
  // O26: one row per title, at its newest send; its versions open from it, oldest first (a re-send moves that version to newest).
  const versions = new Map();
  for (const it of out) if (it.type === 'artifact') versions.set(it.art.title, [...(versions.get(it.art.title) ?? []).filter(a => artSig(a) !== artSig(it.art)), it.art]);
  return out.filter(it => it.type !== 'artifact' || versions.get(it.art.title).at(-1) === it.art).map(it => it.type === 'artifact' ? { ...it, versions: versions.get(it.art.title) } : it).reverse();
}
const fwd = p => String(p).replace(/\\/g, '/');
// An agent's file path as a workspace path ('proj/notes.md'), or null outside the workspace (or while its path is not known
// yet). A relative path is from the chat's folder.
function wsPath(p, folder) {
  p = fwd(p); const ws = CF.ws && fwd(CF.ws).replace(/\/$/, '');
  const rel = /^(\/|[A-Za-z]:\/)/.test(p) ? (ws && p.startsWith(ws + '/') ? p.slice(ws.length + 1) : null) : (folder ? folder + '/' : '') + p;
  const parts = rel?.split('/').filter(x => x && x !== '.');
  return !parts?.length || parts.includes('..') ? null : parts.join('/');
}
// The daemon's workspace folder, once, from the setup read the welcome screen uses (the agents' paths are absolute under it).
const loadWs = () => { if (CF.asked) return; CF.asked = true; outer.loadSetup().then(b => { CF.ws = b?.workspace ?? null; if (!CF.ws) CF.asked = false; renderChatFiles(); }, () => { CF.asked = false; }); };
function openChatFiles(sid) {
  if (CF.sid !== sid && outer.side.current()?.slot === 'chat-files') localStorage.removeItem(cfKey(CF.sid)); // one list open at a time
  if (CF.sid !== sid) CF.tab = localStorage.getItem(cfKey(sid)) === 'changes' ? 'changes' : 'artifacts';
  CF.sid = sid; localStorage.setItem(cfKey(sid), CF.tab); loadWs();
  outer.side.open('chat-files', { title: 'Artifacts and changes', focuses: ['chat'], defaultWidth: w => w / 3, render: () => { CF.html = null; renderChatFiles(); },
    onClose: why => { if (why === 'close') localStorage.removeItem(cfKey(sid)); queueMicrotask(() => renderChats()); } }); // 'hidden' and 'replaced' keep it remembered
  renderChats();
}
function renderChatFiles() {
  const b = outer.side.body; if (outer.side.current()?.slot !== 'chat-files') return;
  const s = outer.S.sessions.find(x => x.id === CF.sid), all = s ? chatItems(s) : [], changes = CF.tab === 'changes';
  const arts = all.filter(it => it.type === 'artifact'), files = all.filter(it => it.type === 'file'), items = changes ? files : arts;
  const row = (it, i) => {
    if (it.type === 'artifact') return `<li><button type="button" class="cf-item" data-cf="${i}" title="Open the artifact"><span class="art-kind">${esc(KIND_NAMES[it.art.kind])}</span><span class="cf-name">${esc(it.art.title)}</span><span class="cf-sub">Artifact${it.versions.length > 1 ? ` · ${it.versions.length} versions` : ''}</span></button></li>`;
    const rel = wsPath(it.path, s.folder), shown = rel ?? fwd(it.path), cut = shown.lastIndexOf('/');
    const where = rel === null ? (CF.ws ? 'outside the workspace, ' : '') + (shown.slice(0, cut) || '/') : cut < 0 ? 'workspace' : shown.slice(0, cut);
    return `<li><button type="button" data-cf="${i}" title="Show the changes to ${esc(shown)} (read-only)" class="cf-item" data-cf-file><span class="art-kind">Diff</span><span class="cf-name">${esc(shown.slice(cut + 1))}</span><span class="cf-sub">${esc((it.created ? 'Created' : 'Edited') + ' · ' + where)}</span></button>`
      + `<button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-cf-copy="${i}" title="Copy ${esc(fwd(it.path))}">Copy path</button></li>`;
  };
  const tab = (id, label, n) => `<button type="button" role="tab" data-slot="button" data-variant="ghost" data-size="sm" data-cf-tab="${id}" aria-selected="${CF.tab === id}">${label} <span class="cf-n">${n}</span></button>`;
  const html = `<div class="cf-tabs" role="tablist">${tab('artifacts', 'Artifacts', arts.length)}${tab('changes', 'Changes', files.length)}</div>`
    + (items.length ? `<ul class="cf-list" role="tabpanel">${items.map(row).join('')}</ul>` : `<p class="empty" role="tabpanel">${changes ? 'No changes yet. The files this chat edits show here; click one to read its diff.' : 'No artifacts yet. The artifacts this chat posts show here.'}</p>`);
  if (CF.html === html) return; // called on every chat change: the DOM is left alone when nothing in it changed
  CF.html = html; b.innerHTML = html;
  b.querySelectorAll('[data-cf-tab]').forEach(el => el.onclick = () => { CF.tab = el.dataset.cfTab; localStorage.setItem(cfKey(CF.sid), CF.tab); renderChatFiles(); });
  b.querySelectorAll('[data-cf]').forEach(el => el.onclick = () => { const it = items[+el.dataset.cf]; if (it.type === 'artifact') openArtifact({ ...it.art, sid: s.id, list: true, versions: it.versions.map(v => ({ ...v, sid: s.id })) }); else openChange(s, it); });
  b.querySelectorAll('[data-cf-copy]').forEach(el => el.onclick = () => copy(fwd(items[+el.dataset.cfCopy].path), el));
}
// A changed file's diffs, read-only, in the artifact view as plain text (artifact.mjs frameDoc 'diff'): every finished edit call
// of the loaded chat that wrote it, oldest first, each as the line diff the chat shows (editFiles keeps one per file).
function openChange(s, it) {
  const edits = s.events.filter(e => e.t === 'tool' && e.status === 'completed' && e.files?.some(f => f.path === it.path)).map(e => e.files.find(f => f.path === it.path).diff);
  const src = edits.map((rows, i) => (edits.length > 1 ? `@@ Edit ${i + 1} of ${edits.length} @@\n` : '')
    + (rows?.length ? rows.map(([k, l]) => (k === 'add' ? '+ ' : k === 'del' ? '- ' : '  ') + l).join('\n') : 'No diff was recorded for this edit.')).join('\n\n');
  openArtifact({ kind: 'diff', lang: 'diff', mode: 'panel', title: wsPath(it.path, s.folder) ?? fwd(it.path), src, sid: s.id, list: true });
}
// From renderChats, in Chat Focus: the open list follows its chat (another chat shown hides it, still remembered), and a
// remembered one comes back when its chat is shown and the panel is free.
function chatFilesFollow(ids) {
  if (outer.S.focus !== 'chat') return;
  if (outer.side.current()?.slot === 'chat-files' && !ids.includes(CF.sid)) outer.side.close('chat-files', 'hidden');
  const want = !outer.side.current() && ids.find(id => localStorage.getItem(cfKey(id)) && outer.S.sessions.some(s => s.id === id && !s.stub && chatItems(s).length));
  if (want) openChatFiles(want); else renderChatFiles();
}
function focus(id) { const s = outer.S.sessions.find(x => x.id === id); if (s?.hidden) s.hidden = false; show(id); outer.renderTabs(); renderChats(); }
// The chat shown goes first and the one before it second, so Split has the last two (Builder, 2026-10-19: replacing only
// the first kept a one-tab start at one open chat, and Split showed one pane).
const show = id => { outer.S.view = null; outer.S.open = [id, ...outer.S.open.filter(x => x !== id)].slice(0, 2); if (outer.S.files) outer.renderTree(); }; // Current project files follow the chat shown
// N1: Stop is final (no Undo): on the chat's row and first in its menu (panel.mjs), and in its header. The chat stays in
// the panel's list; a message sent to it starts it again.
function stopChat(s) { if (s.live) return outer.liveChat.stop(s); cancelTurn(s, true); s.state = 'stopped'; s.pending = null; s.events = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'); s.events.push({t:'notice', text:'Stopped. Resume continues the native session.'}); outer.renderTabs(); renderChats(); }
const untab = id => { outer.S.open = outer.S.open.map(o => o === id ? (outer.S.sessions.find(x => !x.hidden && !outer.S.open.includes(x.id)) || {}).id : o).filter(Boolean); outer.renderTabs(); renderChats(); };
function newSession(agent, model, project = null, profile = '') {
  outer.usedAgent(agent);
  // Builder, 2026-11-02 ("no way to start a new chat here in dev focus"): one started from Dev Focus is the chat beside the editor.
  if (outer.S.focus === 'dev') { outer.S.sideId = null; outer.setSideChat(true); }
  if (outer.liveChat.on) return outer.liveChat.create(agent, project ? '' : outer.newFolder, project, model, profile);
  const s = { id: 's-' + Date.now(), agent, title: `${outer.names[agent]} ${outer.S.sessions.filter(x => x.agent === agent).length + 1}`, model, mode: outer.startMode(agent), queue: [], effort: 'Medium', state: 'idle', pending: null, context: null, limits: outer.M.sessions[agent === 'claude' ? 0 : 1].limits, cacheMin: null, cwd: outer.M.sessions[0].cwd, events: [] };
  s.project = project; outer.S.sessions.push(s); show(s.id); outer.renderTabs(); renderChats();
}
// U4 on a remote (Builder, 2026-11-02: "no window at all"; "just a normal file picker would be better than clicking the .."):
// a folder dialog like the system's. A path bar (type or paste, Enter goes there), Up, clickable breadcrumbs, the folder
// list (a click selects, a double click or Enter opens), Select and Cancel. In Unrestricted mode it walks the whole server
// (/files/folders); with either switch on, or a server P9 older than that route, it walks the workspace (/files/list) and
// says why it stops at the workspace's top instead of silently not going up. The daemon checks the folder again at start.
const FOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';
const FOLDER_WHY = {
  locked: 'Only the workspace is shown because the agent lock or File protection is on. Turn both off in Settings (Unrestricted mode) to choose any folder on the server.',
  old: 'Only the workspace is shown because the P9 on this server is older than this app and cannot list other folders. Update P9 on the server to browse all of it; a full path typed above still works in Unrestricted mode.',
};
const folderRefused = (r, to) => r?.body?.error === 'unrestricted-only' ? FOLDER_WHY.locked
  : r?.body?.error === 'private-folder' ? `${to} holds P9's own files, so a chat cannot start there.`
  : r?.status === 404 ? `There is no folder at ${to} on the server.`
  : r?.status === 403 ? `P9 cannot open ${to}: it is a file, or the server does not let P9 read it.`
  : r?.status === 400 ? 'Type a full path, starting with /.' : 'The server did not answer. Try again.';
// Send to remote from a chat outside the workspace (U4) opens it too: ask lists the remote through main (the window's daemon
// may be this computer's), note says why it opened, verb names the foot ('Lands in:').
const pickRemoteFolder = ({ ask = (kind, path) => window.p9.mission(kind, { path }), title = 'Choose a folder on the server', note = '', verb = 'Start in' } = {}) => new Promise(done => {
  const d = outer.$('#folderDlg'), list = outer.$('#folderList'), bar = outer.$('#folderPath'), why = outer.$('#folderWhy');
  // whole: null until the first answer, true for the whole server (full paths), false for the workspace walk (paths
  // relative to it, '' its top). at: the folder shown; up: its parent (null at the top); picked: the row clicked once.
  let whole = null, ws = '', limit = '', at = '', up = null, picked = null, shown = 0, drawn = false;
  const say = text => { why.textContent = text; why.hidden = !text; };
  const label = f => whole ? f : f ? 'Workspace/' + f : 'Workspace';
  // A relative path typed in whole-server mode is taken from the folder shown.
  const typed = () => { const t = bar.value.trim().replace(/(.)\/+$/, '$1'); return whole && t && !t.startsWith('/') ? (at === '/' ? '' : at) + '/' + t : t.replace(/^\.\/?/, ''); };
  const chosen = () => { const t = typed(), f = picked ?? (t && t !== at ? t : at); return whole && f === ws ? '' : f; }; // the workspace stays ''
  const foot = () => { const f = chosen(); outer.$('#folderAt').textContent = verb + ': ' + (f === '' ? 'Workspace' : f); };
  const draw = (to, parent, dirs) => {
    at = to; up = parent; picked = null; drawn = true; bar.value = at; bar.placeholder = whole ? '' : 'Workspace';
    outer.$('#folderUp').disabled = up === null;
    // ponytail: breadcrumbs split on '/', so a Windows server gets one crumb; the bar and Up still work there.
    const parts = at.split('/').filter(Boolean), base = whole ? [['/', '/']] : [['', 'Workspace']];
    const crumbs = [...base, ...parts.map((p, i) => [(whole ? '/' : '') + parts.slice(0, i + 1).join('/'), p])];
    outer.$('#folderCrumbs').innerHTML = crumbs.map(([key, name], i) => `${i > 1 || (i && !whole) ? '<i>›</i>' : ''}<button type="button" data-fcrumb="${esc(key)}"${i === crumbs.length - 1 ? ' aria-current="location"' : ''}>${esc(name)}</button>`).join('');
    list.innerHTML = dirs ? dirs.map(([key, name]) => `<button type="button" role="option" aria-selected="false" data-fdir="${esc(key)}">${FOLDER_ICON}<span class="truncate">${esc(name)}</span></button>`).join('') || '<p class="sm muted">No folders here.</p>' : '';
    say(note || (whole ? '' : limit));
    foot();
  };
  const go = async to => {
    const mine = ++shown;
    if (whole !== false) {
      const r = await ask('folders', to).catch(() => null);
      if (mine !== shown) return;
      if (r?.status === 200) { whole = true; ws = r.body.workspace; draw(r.body.path, r.body.parent, r.body.dirs.map(e => [e.path, e.name])); return; }
      if (whole) { say(folderRefused(r, to)); return; } // stays where it was, and says why
      // The first ask is the workspace itself: 403 means a switch is on; any other refusal, a server P9 without the route.
      whole = false; limit = r?.body?.error === 'unrestricted-only' ? FOLDER_WHY.locked : FOLDER_WHY.old; to = '';
    }
    // A full path cannot be listed in the workspace walk: say why; Select still sends it and the daemon decides.
    if (to.startsWith('/')) { say(limit); foot(); return; }
    const r = await ask('list', to).catch(() => null);
    if (mine !== shown) return;
    if (r?.status === 200) draw(to, to ? to.split('/').slice(0, -1).join('/') : null, r.body.entries.filter(e => e.dir).map(e => e.name).sort().map(n => [(to ? to + '/' : '') + n, n]));
    else { if (!drawn) draw(to, null, null); say(r?.status === 404 ? `There is no folder at ${label(to)}.` : folderRefused(r, label(to))); }
  };
  const pick = key => { picked = key; list.querySelectorAll('[data-fdir]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.fdir === key))); foot(); };
  list.onclick = e => { const b = e.target.closest('[data-fdir]'); if (b) pick(b.dataset.fdir); };
  list.ondblclick = e => { const b = e.target.closest('[data-fdir]'); if (b) go(b.dataset.fdir); };
  list.onkeydown = e => { const b = e.target.closest('[data-fdir]'); if (b && e.key === 'Enter') { e.preventDefault(); go(b.dataset.fdir); } };
  outer.$('#folderCrumbs').onclick = e => { const b = e.target.closest('[data-fcrumb]'); if (b) go(b.dataset.fcrumb); };
  outer.$('#folderUp').onclick = () => { if (up !== null) go(up); };
  bar.oninput = () => { picked = null; list.querySelectorAll('[aria-selected="true"]').forEach(b => b.setAttribute('aria-selected', 'false')); foot(); };
  // Enter goes to the typed folder; the form never submits from the bar.
  bar.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(typed()); } };
  outer.$('#folderT').textContent = title; d.returnValue = ''; bar.value = ''; drawn = false; list.innerHTML = '<p class="sm muted">Loading…</p>'; outer.$('#folderCrumbs').innerHTML = ''; say(note); outer.$('#folderAt').textContent = '';
  d.onclose = () => done(d.returnValue === 'yes' ? chosen() : undefined);
  d.showModal(); go('');
});
const recentFolders = () => { try { const r = JSON.parse(localStorage.getItem('eh-chat-folders')); return Array.isArray(r) ? r.filter(f => typeof f === 'string').slice(0, 5) : []; } catch { return []; } };
function renderNewFolder() {
  const seen = new Set(), opts = [['', 'Workspace'], ...(outer.live.primary ? [[outer.live.primary.path, 'Main project · ' + outer.live.primary.name]] : []), ...[outer.newFolder, ...recentFolders()].map(f => [f, f])]
    .filter(([v]) => !seen.has(v) && seen.add(v));
  outer.$('#newFolder').innerHTML = opts.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('') + (window.p9?.pickFolder ? '<option value=":pick">Choose folder…</option>' : '');
  outer.$('#newFolder').value = outer.newFolder;
}
// Live chats: context from the agent's usage_update, 5 h and 7 d from the daemon's /usage for this agent (a reading over
// an hour old is dimmed), the cache timed from the last turn end (Claude only: its prompt cache lasts an hour).
// One limit window as a bar (chat meters and Mission's Usage panel); an expired window shows a dash.
// Amber from 75% on every bar (MR1).
const HOT = 75;
// mins: the window's length; with it the bar carries the pace tick (where even use would be now, helpers.mjs paceOf).
const meterBar = (label, w, line, now = Date.now(), mins = 0) => { const p = !w || w.resetsAt && w.resetsAt < now ? null : Math.round(w.usedPercent), pace = mins ? paceOf(w, mins, now) : null;
  return `<div class="meter" title="${esc(line.text)}"${line.stale ? ' data-stale' : ''}><div class="l"><span>${label}</span><b>${p == null ? '—' : p + '%'}</b></div><div class="mbar"${pace ? ` data-pace="${pace.state}"` : ''}><div class="fx-meter" ${p >= HOT ? 'data-hot' : ''}><span style="width:${p || 0}%"></span></div>${pace ? `<u class="ptick" style="left:${Math.round(pace.elapsed * 1000) / 10}%"></u>` : ''}</div></div>`; };
// Each agent's plan windows as rows (the Usage window, Mission's Usage card): helpers.mjs paceRow, the phone draws the same.
const usageRows = () => { const now = Date.now(); return Object.keys(outer.names).filter(a => outer.usage.limits?.[a]).map(a => { const lim = outer.usage.limits[a], line = limitLine(outer.names[a], lim, now); return `<section class="uagent" data-agent="${a}"${line.stale ? ' data-stale' : ''}><h5>${outer.names[a]}<small>${esc(line.text.split(' · ').at(-1))}</small></h5>${planWindows(lim).map(([label, w, mins]) => paceRow(label, w, mins, now)).join('')}</section>`; }).join(''); };
// The cache clock: text and state, so the 15 s tick can move it without rebuilding the pane.
const cacheOf = s => {
  const cacheMin = !s.live ? s.cacheMin : s.agent === 'claude' && s.lastEnd ? Math.floor((Date.now() - s.lastEnd) / 60000) : null;
  const left = cacheMin == null ? null : 60 - cacheMin;
  return left == null ? ['—', ''] : left <= 0 ? ['cold', 'cold'] : [left + ' min', left < 20 ? 'cooling' : 'warm'];
};
function meters(s) {
  const ctx = s.context ? Math.round(s.context.used / s.context.size * 100) : null;
  const lim = s.live ? outer.usage.limits?.[s.agent] : { fiveHour: { usedPercent: s.limits.h5 * 100 }, sevenDay: { usedPercent: s.limits.d7 * 100 }, asOf: Date.now() };
  const line = limitLine(outer.names[s.agent], lim), now = Date.now();
  const bar = (label, w, mins) => meterBar(label, w, line, now, mins);
  const cache = cacheOf(s);
  return `<div class="meters">
    <div class="meter" title="${esc(ctx == null ? 'No context size reported by this agent yet' : s.context.used.toLocaleString() + ' of ' + s.context.size.toLocaleString() + ' tokens')}"><div class="l"><span>Context</span><b>${ctx == null ? '—' : ctx + '%'}</b></div><div class="fx-meter" ${ctx >= HOT ? 'data-hot' : ''}><span style="width:${ctx || 0}%"></span></div></div>
    ${s.profile ? '' : bar('5 h', lim?.fiveHour, 300) + bar('7 d', lim?.sevenDay, 10080)}
    <div class="cache" data-s="${cache[1]}" title="How long the agent still has this chat saved for a cheaper next message (the 1-hour prompt cache, counted from its last output)">${svg.clock}${cache[0]}</div>
  </div>`;
}
const loadImg = (s, hash) => { if (outer.chatImgs.has(hash) || !s.live) return; outer.chatImgs.set(hash, '');
  window.p9.chat('image', { id: s.id, hash }).then(r => { if (r.status === 200) { outer.chatImgs.set(hash, `data:${esc(r.body.mimeType)};base64,${esc(r.body.data)}`); renderChats(new Set([s.id])); } else if (r.status !== 404) outer.chatImgs.delete(hash); }); };
function event(e, s) {
  switch (e.t) {
    case 'user': return `${Array.isArray(e.images) ? `<div class="user-imgs">${e.images.map(i => `<img data-chat-img="${esc(i.hash)}"${outer.chatImgs.get(i.hash) ? ` src="${outer.chatImgs.get(i.hash)}"` : ''} alt="Sent image">`).join('')}</div>` : ''}<div class="msg user"><div class="who">You${e.when ? ' · ' + esc(e.when) : ''}</div>${esc(e.text)}${e.images ? `<div class="xs muted" style="margin-top:6px">📎 ${esc(e.images.length ?? e.images)} image${(e.images.length ?? e.images) > 1 ? 's' : ''}</div>` : ''}</div>`;
    case 'agent': return `<div class="msg agent"><div class="who">${outer.names[s.agent]}</div>${outer.mdOf(e)}${agentImgs(e.images, outer.names[s.agent])}</div>`;
    case 'warn': return warnHtml(e.text, ' data-ev="' + s.events.lastIndexOf(e) + '"' + (e.open ? ' open' : ''));
    case 'thought': return `<details class="thought" data-ev="${s.events.lastIndexOf(e)}"${e.open ? ' open' : ''}><summary>Thinking</summary><p>${esc(e.text)}</p></details>`;
    case 'tool': return `<details class="tool" data-ev="${s.events.lastIndexOf(e)}"${(e.open ?? e.status === 'in_progress') ? ' open' : ''}><summary><span class="chev">${svg.chev}</span><span data-slot="badge" data-variant="${e.status === 'completed' ? 'ok' : e.status === 'failed' ? 'bad' : 'primary'}">${esc(e.status.replace('_',' '))}</span><span class="ttl truncate">${esc(e.title)}</span></summary>${e.diff ? diff(e.diff) : ''}${e.output ? `<pre>${esc(e.output)}</pre>` : e.status === 'in_progress' ? '<pre class="caret"></pre>' : ''}</details>${e.plan ? `<button data-slot="button" data-variant="outline" data-size="sm" class="open-plan" data-open-plan="${s.events.lastIndexOf(e)}">Open plan</button>` : ''}${agentImgs(e.images, outer.names[s.agent])}`;
    case 'notice': return `<div class="notice">${esc(e.text)}${e.restart && window.p9?.restartService ? ' <button data-slot="button" data-variant="outline" data-size="sm" data-restart-p9>Restart P9</button>' : ''}</div>`;
    case 'error': return `<div class="notice" style="color:var(--destructive)">${esc(e.text)}${/^(Claude Code|Codex) is not signed in on this computer\./.test(e.text) && window.p9?.agentLogin ? ' <button data-slot="button" data-variant="outline" data-size="sm" data-signin>Sign in</button>' : ''}</div>`;
  }
  return '';
}
const diff = rows => `<div class="diff">${rows.map(([k, l]) => `<div class="${esc(k)}">${k === 'add' ? '+' : k === 'del' ? '−' : ' '} ${esc(l)}</div>`).join('')}</div>`;
function pending(s) {
  if (s.pending === 'approval') { const a = s.events.find(e => e.t === 'approval'); return `<div class="pending fx-halo" role="group" aria-label="Approval"><div class="eyebrow">Approval needed</div><h4>${esc(a.title)}</h4>${diff(a.diff)}${a.plan ? `<button data-slot="button" data-variant="outline" data-size="sm" data-open-plan="${s.events.indexOf(a)}">Open plan</button>` : ''}${s.live ? '<p class="hint">Sending a message declines this and sends the message instead.</p>' : ''}<div class="acts">${a.options.map(([k, l, kind]) => `<button data-slot="button" data-variant="${(kind || k).startsWith('reject') ? 'outline' : 'default'}" data-size="sm" class="fx-lift" data-approve="${esc(k)}">${esc(l)}</button>`).join('')}</div></div>`; }
  if (s.pending === 'question') { const q = s.events.find(e => e.t === 'question'); return `<form class="pending fx-halo" data-question><div class="eyebrow">${outer.names[s.agent]} asks</div><h4>${esc(q.title)}</h4>${q.unsupported ? '<p class="hint">P9 cannot show this form faithfully. Decline, or answer in a message.</p>' : ''}${s.live ? '<p class="hint">Sending a message declines this question and sends the message instead.</p>' : ''}${q.fields.map((f, i) => { const head = `<span>${esc(f.label)}${f.required ? ' *' : ''}</span>${f.hint ? `<small>${esc(f.hint)}</small>` : ''}`; return f.kind === 'radio' ? `<div class="field">${head}${f.options.map(outer.opt).map(([v, l]) => `<label><input type="radio" name="f${i}" value="${esc(v)}" ${(q.vals?.['f' + i] ?? ('def' in f ? f.def : outer.opt(f.options[0])[0])) === v ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>`
    : f.kind === 'multi' ? `<div class="field">${head}${f.options.map(outer.opt).map(([v, l], j) => `<label><input type="checkbox" name="f${i}~${j}" value="${esc(v)}" ${q.vals?.[`f${i}~${j}`] !== undefined ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>` : `<div class="field">${head}<input data-slot="input" name="f${i}" value="${esc(q.vals?.['f' + i] || '')}"></div>`; }).join('')}<div class="acts">${q.unsupported ? '' : '<button data-slot="button" data-variant="default" data-size="sm" type="submit">Submit answer</button>'}<button data-slot="button" data-variant="outline" data-size="sm" type="button" data-decline>Decline</button></div></form>`; }
  return '';
}
// A turn is in flight while a tool runs or a reply streams; messages and mode changes queue behind it.
const busy = s => s.live ? s.state === 'running' && !s.pending && !!s.working : s.state === 'running' && !s.pending && (!!s.streaming || s.events.some(e => e.t === 'tool' && e.status === 'in_progress'));
// Only a chat's latest TAIL steps are drawn (Builder, 2026-10-20: the window lagged and froze; one redraw of a 25,000-event
// chat built 31 MB of HTML in about 170 ms, and live chats redraw on every batch). "Show earlier" adds TAIL more.
const TAIL = 200;
function shown(s) {
  const list = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'), from = Math.max(0, list.length - (s.tail || TAIL));
  return (from || s.more !== undefined ? `<button data-slot="button" data-variant="ghost" data-size="sm" class="earlier" data-earlier>Show earlier${from ? ` (${from.toLocaleString()} more)` : ''}</button>` : '')
    + list.slice(from).map(e => event(e, s)).join('');
}
/* ---------- the message bar's pills (0.1.8): Mode, Model and Effort, one menu kept outside the panes ----------
   Panes are rebuilt from S on every change (every 18 ms while a reply streams); morph keeps each pill button by position and
   only its attributes change, and the menu is never part of a pane, so it stays open with its focus while a chat streams,
   and refreshPill brings its checked item up to date. Each pill is a button with aria-haspopup; the menu is role=menu with
   menuitemradio choices; Escape closes it and focuses its pill; arrows move; Enter picks. The Model menu lists the agent's
   models directly, then Fast mode under its own heading (Builder, 2026-11-05: no "More" submenu). Live chats list the agent's
   own models; the sample data keeps its two names. */
// O47: a chat whose own report is older than the agent's kept list (a chat not run since) offers the kept list, so a
// model the agent dropped is gone from its menu; its own model stays its current one (goneModel says so in the menu).
// O48: a chat on a provider profile has the one model it was started on, whatever the agent or the kept list says.
const profileModels = s => ({ current: s.profile.model, options: [{ value: s.profile.model, name: s.profile.model }] });
const liveModels = s => { if (s.profile) return profileModels(s); const kept = outer.lastModels[s.agent], own = s.models; return own && kept && (s.modelsAt || 0) < (outer.listsAt[s.agent] || 0) ? { current: own.current, options: kept.options } : own || kept || null; };
const goneModel = s => { const m = s.live && liveModels(s), v = s.modelPick || m?.current; return m && v && !m.options.some(o => o.value === v) ? s.model || v : ''; };
const dflt = (s, id, o) => o.name + (s.live && !s.profile && !/default/i.test(o.name) && outer.isDefault(s.agent, id, o.value) ? ' (Default)' : ''); // MC-16; an option the agent itself names its default is left as it is
const modelList = s => s.live ? liveModels(s) : { current: s.model, options: [s.model, s.agent === 'codex' ? 'gpt-5.1-codex-mini' : 'Sonnet 5.5'].map(v => ({ value: v, name: v })) };
const modelName = s => { const m = modelList(s), v = s.modelPick || m?.current, o = m?.options.find(o => o.value === v); return o ? dflt(s, null, o) : s.model; };
// The sample data, and a live chat before its config, keep Effort as a local choice.
const pickers = s => s.live && (s.pickers || outer.lastPickers[s.agent]) || [];
const pickerOf = (s, kind) => pickers(s).find(p => outer.pickerKind(p) === kind);
const pickVal = (s, p) => s.pick?.[p.id] ?? p.current;
const setPick = (s, p, v) => { s.pick ||= {}; if (v === p.current) delete s.pick[p.id]; else s.pick[p.id] = v; };
const effortList = s => pickerOf(s, 'effort')?.options || [...new Set([s.effort, 'High', 'Low'])].map(v => ({ value: v, name: v }));
const effortName = s => { const p = pickerOf(s, 'effort'); if (!p) return s.effort; const v = pickVal(s, p), o = p.options.find(o => o.value === v); return o ? dflt(s, p.id, o) : v; };
const planOpt = p => p.options.find(o => /plan/i.test(o.value)) || p.options.find(o => /plan/i.test(o.name));
const planOn = s => { const p = pickerOf(s, 'collab'); return !!p && pickVal(s, p) === planOpt(p)?.value; };
// The Mode menu's order per agent. Codex's Plan is its plan collaboration mode on top of the sandbox mode picked before
// (s.mode stays that mode; choosing any other mode turns plan off); Claude's is its own plan mode.
const MODE_ORDER = { claude: ['Manual', 'Auto', 'Accept edits', 'Plan', 'Bypass permissions'], codex: ['Read-only', 'Workspace access', 'Auto review', 'Full access', 'Plan'] };
const modeNow = s => planOn(s) ? 'Plan' : s.mode;
const modeShown = s => s.modeNext || modeNow(s);
function setMode(s, m) {
  const p = s.agent === 'codex' ? pickerOf(s, 'collab') : null, plan = p && planOpt(p);
  if (plan && m === 'Plan') return setPick(s, p, plan.value);
  if (s.live && s.agent === 'codex' && m === 'Plan') return; // not offered yet: the menu shows it disabled
  if (plan && planOn(s)) setPick(s, p, p.options.find(o => o !== plan).value);
  s.mode = m;
}
const PM = { sid: null, kind: null, btn: null, html: '', ac: null }; // the open menu: chat id, Mode | Model | Effort, its pill, its markup, its window listeners
const pill = (s, kind, label, extra = '', pre = '') => `<button type="button" class="pill" data-pill="${kind}" aria-haspopup="menu" aria-expanded="${PM.sid === s.id && PM.kind === kind}" aria-label="${kind}: ${esc(label)}" title="${kind}: ${esc(label)}">${pre}<span class="truncate">${esc(label)}</span>${extra}</button>`;
const agentDot = a => `<span class="dot" data-agent="${esc(a)}"></span>`;
const pills = s => pill(s, 'Agent', outer.names[s.agent], '', agentDot(s.agent)) + pill(s, 'Mode', modeShown(s), s.modeNext ? '<span class="mode-q" title="Applies when this turn ends">queued</span>' : '') + pill(s, 'Model', modelName(s)) + pill(s, 'Effort', effortName(s));
document.body.insertAdjacentHTML('beforeend', '<div class="pop" id="pillMenu" role="menu" hidden></div>');
const pmRoot = () => document.getElementById('pillMenu'); // not outer.$: installChat runs before controller.mjs defines $
const mi = (label, checked, data, disabled) => `<button type="button" class="item" role="menuitemradio" aria-checked="${checked}" ${data}${disabled ? ` aria-disabled="true" title="${esc(disabled)}"` : ''}><span class="truncate">${esc(label)}</span></button>`;
const radio = (list, now, data, s, id) => list.map(o => mi(s ? dflt(s, id, o) : o.name, o.value === now, `${data} data-val="${esc(o.value)}"`)).join('');
// O47: what the Model menu says while this daemon run's fresh read is on, or after it failed (signed out, offline).
const listNote = s => { const st = s.live && outer.listState[s.agent], n = outer.names[s.agent], has = modelList(s)?.options.length;
  return st === 'loading' ? `Reading ${n}'s models…` : st === 'failed' ? (has ? `Could not read ${n}'s models just now. This is the last list it reported.` : `Could not read ${n}'s models. Is ${n} signed in?`) : ''; };
// O29 (Builder, 2026-11-08): the Agent pill. Each row says what a chat on that agent runs with: this chat's own, or the
// other agent's start (its saved mode, and the Default model and effort from Settings when it still offers them).
// A chat with messages keeps its agent (its session is that agent's): the other row is shown, disabled, and says why.
const started = s => !!(s.sent || s.session || s.queue?.length || s.events.some(e => e.t === 'user'));
const STAYS = 'This chat has messages, so it stays on its agent. New chat (+) starts one on the other.';
const startsOn = a => { const m = outer.defaultModel(a), e = outer.defaultEffort(a), p = outer.lastPickers[a]?.find(x => outer.pickerKind(x) === 'effort');
  return [outer.startMode(a), outer.lastModels[a]?.options.find(o => o.value === m)?.name || 'Default model', p?.options.find(o => o.value === e)?.name].filter(Boolean); };
const agentMenu = s => '<div class="hd eyebrow">Agent</div>' + Object.keys(modes).map(a => mi(outer.names[a], a === s.agent, `data-agent="${esc(a)}"`, a !== s.agent && started(s) && STAYS)
  .replace('<span class="truncate">', '<span class="truncate">' + agentDot(a)).replace(/<\/button>$/, `<span class="muted">${esc((a === s.agent ? [modeShown(s), modelName(s), effortName(s)] : startsOn(a)).join(' · '))}</span></button>`)).join('')
  + (started(s) ? `<p class="pm-note muted">${STAYS}</p>` : '');
function pillMenuHtml(s, kind) {
  if (kind === 'Agent') return agentMenu(s);
  if (kind === 'Mode') { const now = modeShown(s), noPlan = s.live && s.agent === 'codex' && !pickerOf(s, 'collab') && 'Codex has not offered its plan mode in this chat yet'; return '<div class="hd eyebrow">Mode</div>' + MODE_ORDER[s.agent].map(m => mi(m, m === now, `data-mode="${esc(m)}"`, m === 'Plan' && noPlan)).join(''); }
  if (kind === 'Effort') { const p = pickerOf(s, 'effort'); return '<div class="hd eyebrow">Effort</div>' + radio(effortList(s), p ? pickVal(s, p) : s.effort, `data-pick="${esc(p?.id ?? '')}"`, p && s, p?.id); }
  const m = modelList(s);
  if (s.profile) return `<div class="hd eyebrow">${esc(s.profile.name)}</div>` + radio(m.options, m.current, 'data-model') + `<p class="pm-note muted" data-list-note>${s.profile.gone ? 'This profile was removed in Settings, so this chat can be read but not continued.' : 'This chat runs on this model only. Start a new chat for another one.'}</p>`;
  const gone = goneModel(s), note = [gone && `This chat was on ${gone}, which ${outer.names[s.agent]} no longer lists. Pick one of these.`, listNote(s)].filter(Boolean);
  return `<div class="hd eyebrow">${outer.names[s.agent]}</div>` + radio(m?.options || [], s.modelPick || m?.current, 'data-model', s, null)
    + note.map(t => `<p class="pm-note muted" data-list-note>${esc(t)}</p>`).join('')
    + pickers(s).filter(p => outer.pickerKind(p) === 'model').map(p => `<hr data-slot="separator"><div class="hd eyebrow">${esc(p.name)}</div>` + radio(p.options, pickVal(s, p), `data-pick="${esc(p.id)}"`)).join('');
}
// Above the pill (below when there is no room); fixed, kept inside the window.
function placePop(pop, rect) {
  pop.hidden = false; const w = pop.offsetWidth, h = pop.offsetHeight, top = rect.top - h - 6 >= 8 ? rect.top - h - 6 : rect.bottom + 6;
  pop.style.left = Math.max(8, Math.min(rect.left, innerWidth - w - 8)) + 'px'; pop.style.top = Math.max(8, Math.min(top, innerHeight - h - 8)) + 'px';
}
const pmItems = () => [...pmRoot().querySelectorAll('[role="menuitemradio"]')];
const pillBtn = () => PM.btn?.isConnected ? PM.btn : document.querySelector(`.pane[data-id="${CSS.escape(PM.sid)}"] [data-pill="${PM.kind}"]`);
function openPill(btn, s, kind) {
  closePill(false); document.querySelectorAll('.pop').forEach(p => { p.hidden = true; });
  const ac = new AbortController(), signal = AbortSignal.any([ac.signal, outer.lifetime.signal]), pop = pmRoot();
  Object.assign(PM, { sid: s.id, kind, btn, ac });
  const home = btn.closest('dialog') || document.body; // a chat modal is in the top layer: the menu must be inside it to be reached
  if (pop.parentElement !== home) home.append(pop);
  pop.innerHTML = PM.html = pillMenuHtml(s, kind); pop.setAttribute('aria-label', kind);
  placePop(pop, btn.getBoundingClientRect()); btn.setAttribute('aria-expanded', 'true');
  (pop.querySelector('[aria-checked="true"]') || pmItems()[0])?.focus();
  // Review minor (2026-11-05): the window hears a click outside and a resize only while a menu is open; closePill removes both.
  // The click that opened this menu reaches the window too, so its own pill is let through.
  window.addEventListener('click', e => { if (!pop.contains(e.target) && e.target.closest?.('[data-pill]') !== PM.btn) closePill(false); }, { signal });
  window.addEventListener('resize', () => closePill(false), { signal });
}
function closePill(back = true) {
  if (!PM.sid) return;
  PM.ac.abort(); pmRoot().hidden = true;
  const btn = pillBtn();
  Object.assign(PM, { sid: null, kind: null, btn: null, html: '', ac: null });
  if (btn) { btn.setAttribute('aria-expanded', 'false'); if (back) btn.focus(); }
}
// Review minor (2026-11-05): an open menu follows its chat while it re-renders (a queued mode applied, the agent's new model or
// effort list): morph keeps the items by position, so the focused one keeps its focus. A chat no longer shown closes it.
function refreshPill() {
  if (!PM.sid) return;
  const s = outer.S.sessions.find(x => x.id === PM.sid), btn = s && pillBtn();
  if (!btn) return closePill(false);
  PM.btn = btn;
  const html = pillMenuHtml(s, PM.kind); if (html !== PM.html) { PM.html = html; outer.morph(pmRoot(), html); }
}
// note 7: a mode picked mid-turn shows at once (queued) but applies when the turn ends (turnEnd). The loosened modes ask first
// (looseOk, red); the last pick is kept per agent for new chats (startMode), Codex's Plan is not a sandbox mode so it is not.
async function pickMode(s, m) {
  if (LOOSE[m] && !localStorage.getItem('p9-mode-ok:' + m) && !await outer.looseOk(s.agent, m)) return;
  if (modes[s.agent].includes(m)) localStorage.setItem('p9-mode:' + s.agent, m);
  if (busy(s)) s.modeNext = m === modeNow(s) ? null : m; else { setMode(s, m); s.modeNext = null; }
  renderChats();
}
// O29: an empty chat changes agent by being made again on the other one, in the same folder or project, with that agent's
// defaults (startDefaults, startMode). Review (2026-11-09): what was typed and attached comes over, and the new chat takes the
// old one's place: its pane in Split, the chat beside the editor in Dev Focus (SWAP, swapIn; the layout as it was at the pick).
// The old one is deleted only if the daemon finds it was never sent to (empty, threat model row O29); else the new one goes
// the same way and the old one stays as it was, and the bar says why.
const SWAP = new Map(); // the new chat's id -> { from, open, side, done }
function swapIn(id) {
  const w = SWAP.get(id), n = outer.S.sessions.find(x => x.id === id);
  if (!w || !w.done || !n) return !!w; // under way: its 'created' does not show it; this does, once the old one is gone
  SWAP.delete(id);
  Object.assign(n, { draft: w.from.draft, images: w.from.images });
  outer.S.open = w.open.map(x => x === w.from.id ? id : x).filter(x => outer.S.sessions.some(o => o.id === x));
  if (w.side === w.from.id) outer.S.sideId = id;
  if (outer.S.modal?.kind === 'chat' && outer.S.modal.id === w.from.id) outer.S.modal.id = id; // opened from the panel in another focus
  outer.renderTabs(); renderChats();
  [...document.querySelectorAll(`.pane[data-id="${CSS.escape(id)}"] [data-pill="Agent"]`)].find(b => b.offsetParent)?.focus(); // the one on screen: a pane, or beside the editor
  return true;
}
async function pickAgent(s, a) {
  if (a === s.agent || started(s)) return;
  if (!s.live) { outer.usedAgent(a); Object.assign(s, { agent: a, mode: outer.startMode(a), title: `${outer.names[a]} ${outer.S.sessions.filter(x => x.agent === a).length + 1}` }); outer.renderTabs(); return renderChats(); }
  const w = { from: s, open: [...outer.S.open], side: outer.S.sideId, done: false };
  const r = await outer.liveChat.create(a, s.project ? '' : s.folder, s.project);
  if (r.status !== 201) return;
  const id = r.body.conversation; SWAP.set(id, w);
  const d = await outer.liveChat.call('deleteChat', { id: s.id, empty: true }, { quiet: true });
  if (d.status !== 200) {
    SWAP.delete(id); outer.S.open = w.open.filter(x => outer.S.sessions.some(o => o.id === x)); renderChats();
    outer.liveChat.call('deleteChat', { id, empty: true });
    return outer.toast({ kind: 'chat', txt: d.body?.error === 'not-empty' ? `This chat has a message now, so it stays on ${outer.names[s.agent]}.` : `${outer.names[a]} was not started: this chat could not be replaced.`, level: 'warn' }, true);
  }
  outer.usedAgent(a); w.done = true; swapIn(id);
}
function pillPick(item) {
  const s = outer.S.sessions.find(x => x.id === PM.sid); if (!s || item.getAttribute('aria-disabled') === 'true') return;
  const v = item.dataset.val;
  if (item.dataset.mode) { closePill(); return pickMode(s, item.dataset.mode); }
  if (item.dataset.agent) { closePill(); return pickAgent(s, item.dataset.agent); }
  if (item.hasAttribute('data-model')) { if (s.live) s.modelPick = v === modelList(s)?.current ? null : v; else s.model = v; }
  else if (item.dataset.pick !== undefined) { const p = pickers(s).find(x => x.id === item.dataset.pick); if (p) setPick(s, p, v); else s.effort = v; }
  closePill(); renderChats();
}
pmRoot().onclick = e => { const item = e.target.closest('.item'); if (item) pillPick(item); };
pmRoot().onkeydown = e => {
  const items = pmItems(), i = items.indexOf(document.activeElement), n = items.length, go = j => { e.preventDefault(); items[(j + n) % n]?.focus(); };
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePill(); }
  else if (e.key === 'ArrowDown') go(i + 1); else if (e.key === 'ArrowUp') go(i - 1); else if (e.key === 'Home') go(0); else if (e.key === 'End') go(n - 1);
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); items[i]?.click(); }
  else if (e.key === 'Tab') closePill(false);
};
// N1: where you are, "project › chat title" (the project's name opens it), and the chat tools that were on the rail.
const crumb = s => { const p = s.project && outer.S.projects?.find(x => x.id === s.project);
  return `<span class="crumb">${p ? `<button class="cp" data-goproj="${esc(p.id)}" title="Open ${esc(p.name)}">${esc(p.name)}</button>${svg.chev}` : ''}<span class="ct" title="${esc(outer.names[s.agent])}">${esc(s.title)}</span></span>`; };
const tool = (k, label, keys) => `<button data-slot="button" data-variant="ghost" data-size="icon-sm" data-tool="${k}" title="${label}${keys ? ' (' + keys + ')' : ''}" aria-label="${label}"${k === 'search' ? '' : ` aria-pressed="${!!{ files: outer.S.files, split: outer.S.split, term: outer.S.termOpen?.chat }[k]}"`}>${svg[k]}</button>`;
const tools = () => `<span class="tools">${tool('files', 'Files')}${tool('search', 'Search files')}${tool('split', 'Split: the last two chats side by side')}${tool('term', 'Terminal', 'Ctrl `')}</span>`;
function pane(s, i, bare) {
  const working = busy(s);
  // D14: a chat on its way to the server, or gone there, takes no messages here.
  const away = s.state === 'moving' || s.state === 'moved', frozen = s.readonly || away || !!s.leaving;
  const stateLabel = { running: 'Running', stopped: s.readonly ? 'Read-only · history' : 'Stopped', idle: 'Not started', stopping: 'Stopping…', moving: 'Moving to the remote…', moved: 'Moved to ' + (s.movedTo || 'the remote') }[s.state];
  const body = s.stub ? '<div class="welcome"><p>Loading this chat…</p></div>' : s.events.length === 0 ?`<div class="welcome"><span class="dot" data-agent="${esc(s.agent)}" data-live></span><h2 class="fx-title">What are we working on?</h2><p>${outer.names[s.agent]} · ${esc(s.cwd)}</p><div class="chips"><span data-slot="badge">${esc(s.model)}</span><span data-slot="badge">${esc(s.mode)}</span></div>${s.live ? '<p data-start-hint>Type your first message below to start.</p>' : `<button data-slot="button" data-variant="secondary" style="margin-top:8px" data-start>Start ${outer.names[s.agent]} chat</button>`}</div>`
    : `<div class="col">${shown(s)}${pending(s)}</div>`;
  return `<section class="pane${i === 0 && outer.S.split ? ' focus' : ''}" data-id="${esc(s.id)}"${outer.hideSteps ? ' data-quiet' : ''}${outer.FX.pull === s.id ? ' data-pulled' : ''} aria-label="${outer.names[s.agent]} chat">
    <div class="ptool"><span class="dot" data-agent="${esc(s.agent)}" ${s.state === 'running' ? 'data-live' : ''}></span>${bare ? `<span class="name">${outer.names[s.agent]}</span>` : crumb(s)}
      <button data-slot="button" data-variant="ghost" data-size="sm" data-steps aria-pressed="${outer.hideSteps}" title="Shows or hides the agent's tool calls and thinking in this chat">${outer.hideSteps ? 'Show steps' : 'Hide steps'}</button>
      ${s.live ? `<button data-slot="button" data-variant="ghost" data-size="sm" data-phone title="Open this chat on your phone">Phone</button>` : ''}
      ${(n => n && !bare ? `<button data-slot="button" data-variant="ghost" data-size="sm" data-chat-files aria-pressed="${outer.side.current()?.slot === 'chat-files' && CF.sid === s.id}" title="Artifacts and files this chat made" aria-label="Artifacts and files (${n})">${svg.files}<span>${n}</span></button>` : '')(s.stub ? 0 : chatItems(s).length)}
      <span class="state" data-s="${s.pending && s.state === 'running' ? 'needs' : esc(s.state)}">${s.pending && s.state === 'running' ? LABEL.needs : stateLabel}</span>
      ${s.state === 'running' ? `<button data-slot="button" data-variant="ghost" data-size="sm" data-stop>Stop</button>` : s.state === 'stopped' ? `<button data-slot="button" data-variant="outline" data-size="sm" data-resume>Resume</button>` : ''}
      ${s.live && s.agent === 'claude' && s.session && !away ? `<button data-slot="button" data-variant="ghost" data-size="sm" data-handoff title="Continue this session in Claude Code Remote Control (claude.ai or the Claude app): stops it here and types the command into a terminal">Hand off</button>` : ''}
      ${s.live && s.session && s.state !== 'moved' && window.p9?.sendToServer && !outer.serverInfo?.host
        ? `<button data-slot="button" data-variant="ghost" data-size="sm" data-send-away ${s.profile ? 'disabled ' : s.leaving ? 'disabled ' : s.state === 'moving' ? '' : busy(s) ? 'disabled ' : ''}title="${s.profile ? 'A chat on a provider profile stays on this computer: its key is not sent to a remote' : s.leaving ? 'Moving this chat to the remote' : s.state === 'moving' ? 'The move did not finish: press to finish it' : busy(s) ? 'Finish or stop the turn first' : 'Move this chat to ' + esc(outer.serverInfo?.last || 'your remote (Settings > Remote Connect)') + ' and carry on there: it stops here, and the remote picks it up where it left off'}">Send to remote</button>` : ''}
      ${bare ? '' : tools()}</div>
    <div class="hist">${body}</div>
    <div class="bottom"><div class="col">${pinned(s, outer.mdOf)}${working || s.sending ? `<div class="working"><span class="glyph" aria-hidden="true">${outer.IND.glyphs[outer.IND.frame % outer.IND.glyphs.length]}</span>${working ? outer.names[s.agent] + ' is working…' : 'Sending…'}</div>` : ''}${s.readonly ? '' : meters(s)}
      ${s.queue.length || s.held?.length ? `<div class="queue">${waiting(s)}${s.queue.map((q, j) => `<div class="q"><span>Queued: ${esc(q)}</span><button title="Interrupt and send this now" data-qnow="${j}">${svg.bolt}</button><button title="Remove from the queue" data-qdel="${j}">${svg.x}</button></div>`).join('')}</div>` : ''}
      <div class="composer"><div class="slash" data-slash hidden></div>${s.images?.length ? `<div class="attach">${s.images.map((im, i) => `<span class="att"><img src="data:${im.mimeType};base64,${im.data}" alt="${esc(im.name)}" title="${esc(im.name)}"><button data-unattach="${i}" title="Remove" aria-label="Remove ${esc(im.name)}">×</button></span>`).join('')}</div>` : ''}<textarea placeholder="${s.state === 'moved' ? 'This chat carries on at ' + esc(s.movedTo || 'the remote') + ': open it there (the title-bar badge switches to it)' : s.state === 'moving' || s.leaving ? 'Moving to the remote…' : s.readonly ? 'Resume this conversation to send' : s.state === 'idle' ? 'Start a chat to send' : 'Message ' + outer.names[s.agent] + '…'}" rows="2" ${frozen ? 'disabled' : ''}>${esc(s.draft || '')}</textarea><div class="bar"><span class="pills">${pills(s)}</span>${working && !frozen ? chip() : ''}<span class="spacer"></span><button data-slot="button" data-variant="ghost" data-size="icon-sm" title="Attach image (max 4)" data-attach>${svg.clip}</button><button data-slot="button" data-size="icon-sm" class="send" ${frozen ? 'disabled ' : ''}title="${working ? 'Steer (Enter). Ctrl click interrupts and sends' : 'Send'}" data-send>${svg.send}</button></div></div></div></div>
  </section>`;
}
// The unseen marks (done, failed) kept over a restart: every place that changes one calls this, or a reload brings back a card already opened.
let unseenKept = false;
outer.keepUnseen = () => { if (unseenKept) try { localStorage.setItem('p9-unseen', JSON.stringify(Object.fromEntries(outer.S.sessions.filter(s => s.failed || s.done).map(s => [s.id, s.failed ? 'failed' : 'done'])))); } catch {} };
// only: the chat ids a daemon batch touched; the other panes shown are left as they are.
function renderChats(only) {
  const ids = outer.S.split ? outer.S.open.slice(0, 2) : outer.S.open.slice(0, 1);
  const ss = ids.map(id => outer.S.sessions.find(s => s.id === id)).filter(Boolean);
  if (document.hasFocus()) { const seen = [...(outer.S.focus === 'chat' ? ss : []), outer.mdl.open && outer.S.modal?.kind === 'chat' && outer.S.sessions.find(s => s.id === outer.S.modal.id)].filter(s => s?.done || s?.failed); seen.forEach(s => { s.done = s.failed = false; }); if (seen.length) outer.renderCards(); }
  outer.keepUnseen();
  outer.$('#chats').dataset.split = String(outer.S.split && ss.length > 1);
  for (const s of [...ss, outer.mdl.open && outer.S.modal?.kind === 'chat' && outer.S.sessions.find(x => x.id === outer.S.modal.id)]) if (s?.stub) history(s);
  paint(outer.$('#chats'), ss, only);
  outer.bottoms.disconnect(); outer.$('#chats').querySelectorAll(':scope > .pane > .bottom').forEach(b => outer.bottoms.observe(b));
  if (outer.mdl.open && outer.S.modal?.kind === 'chat') paint(outer.$('#mdlBody'), [outer.S.sessions.find(s => s.id === outer.S.modal.id)].filter(Boolean), only);
  outer.renderSideChat(only);
  refreshPill();
  if (outer.side.current()?.slot === 'artifact' && ART.mode === 'panel' && outer.S.focus === 'chat' && !chatsInView().includes(ART.state?.sid)) outer.side.close('artifact', 'hidden'); // item 19
  outer.side.refresh(); // a pinned artifact shows only while its chat is in view (O28)
  chatFilesFollow(ids);
  outer.tickPets(); // paint rebuilt the panes: put their pets back now, not on the next frame
}
// The same pane renders in Chat Focus and inside a chat modal; root says which.
// E2: with only, and the same panes still shown in the same order, just those panes are rebuilt and re-wired. Before,
// each daemon batch rebuilt every pane shown, so a quiet 200-step chat beside a streaming one cost the same each time.
function paint(root, ss, only) {
  const bare = root.id === 'mdlBody', old = [...root.querySelectorAll(':scope > .pane')];
  const part = only && old.length === ss.length && old.every((p, i) => p.dataset.id === ss[i].id);
  const panes = part ? old.filter(p => only.has(p.dataset.id)) : old;
  if (part && !panes.length) return;
  panes.forEach(p => { const h = p.querySelector('.hist'), ta = p.querySelector('textarea'); outer.view[root.id + ':' + p.dataset.id] = { top: h.scrollTop, pinned: h.scrollHeight - h.scrollTop - h.clientHeight < 24, selection: [ta.selectionStart, ta.selectionEnd] }; });
  const a = document.activeElement, caret = a?.matches('textarea, [data-question] input[data-slot]') && root.contains(a) ? { id: a.closest('.pane').dataset.id, n: a.name, s: a.selectionStart, e: a.selectionEnd } : null;
  if (part) panes.forEach(p => { const i = old.indexOf(p), t = document.createElement('template'); t.innerHTML = pane(ss[i], i, bare); outer.addHalos(t.content); outer.attrs(p, t.content.firstElementChild); outer.sync(p, t.content.firstElementChild); });
  else outer.morph(root, ss.map((s, i) => pane(s, i, bare)).join('<div class="handle-v" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize the two chats (arrow keys)"></div>'));
  const split = root.id === 'chats' && root.querySelector(':scope > .handle-v'); // morph keeps the bar by position; wire it once
  if (split && !outer.wiredBars.has(split)) { outer.wiredBars.add(split); dragBar(split, { axis: 'x', get: () => root.querySelector('.pane').offsetWidth, set: px => root.style.setProperty('--split-l', px + 'px'), min: 280, max: () => root.clientWidth - 281, signal: outer.lifetime.signal }); }
  (part ? panes : root.querySelectorAll('.pane')).forEach(p => {
    const s = outer.S.sessions.find(x => x.id === p.dataset.id), h = p.querySelector('.hist'), v = outer.view[root.id + ':' + s.id];
    const place = () => h.scrollTo({ top: !v || v.pinned ? 1e6 : v.top, behavior: 'instant' });
    place(); if (!v) document.fonts.ready.then(() => requestAnimationFrame(place)); // first paint: late font swap leaves it short of the bottom
    p.querySelectorAll('details[data-ev]').forEach(d => d.ontoggle = () => { s.events[d.dataset.ev].open = d.open; });
    p.querySelectorAll('img[data-chat-img]:not([src])').forEach(img => loadImg(s, img.dataset.chatImg));
    p.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => { if (s.live) return outer.liveChat.approve(s, b.dataset.approve); const a = s.events.find(e => e.t === 'approval'); s.events = s.events.filter(e => e !== a); s.pending = null; if (b.dataset.approve === 'reject') { s.events.push({t:'notice', text:'Denied: ' + a.title + '. ' + outer.names[s.agent] + ' will take another approach.'}); reply(s, 'Understood, I will not touch server.ts. I can expose the grace through the existing /api/conversations payload instead; say so and I will do that.'); } else { s.events.push({t:'tool', status:'completed', title:a.title, diff:a.diff}); const plan = s.events.find(e => e.t === 'plan'); if (plan) { plan.entries[2][0] = 'completed'; plan.entries[3][0] = 'in_progress'; } reply(s, 'Bootstrap now carries leaseGraceMs. Next I will read it in the chat-pane footer so the 60 s copy stops being hardcoded.'); } answered(s); });
    const q = p.querySelector('[data-question]'); if (q) { q.oninput = e => { const qe = s.events.find(e => e.t === 'question'); qe.vals = Object.fromEntries(new FormData(q)); (qe.touched ??= new Set()).add(e.target.name.split('~')[0]); }; q.onsubmit = e => { e.preventDefault(); if (s.live) return outer.liveChat.answer(s, Object.fromEntries(new FormData(q))); const v = new FormData(q).get('f0'), qe = s.events.find(e => e.t === 'question'); s.events = s.events.filter(e => e.t !== 'question'); s.pending = null; s.events.push({t:'tool', status:'completed', title:qe.title, output:'answer: ' + v}); reply(s, v); answered(s); }; q.querySelector('[data-decline]').onclick = () => { if (s.live) return outer.liveChat.decline(s); s.events = s.events.filter(e => e.t !== 'question'); s.pending = null; s.events.push({t:'notice', text:'Question declined.'}); answered(s); }; }
    const ta = p.querySelector('textarea');
    if (v?.selection) ta.setSelectionRange(...v.selection);
    // Slash commands: the agent's own list (available_commands_update) while the box holds only "/name"; Tab, Enter or a click fills one in, the agent runs it.
    const slash = p.querySelector('[data-slash]');
    const showSlash = () => {
      const m = /^\/(\S*)$/.exec(ta.value), all = m ? s.commands || outer.lastCommands[s.agent] || [] : [], list = [...all.filter(c => c.name.startsWith(m[1])), ...all.filter(c => !c.name.startsWith(m[1]) && c.name.includes(m[1]))].slice(0, 60); // prefix first, then anywhere; the menu scrolls
      slash.hidden = !list.length;
      slash.innerHTML = list.map(c => `<button type="button" data-cmd="${esc(c.name)}"><b>/${esc(c.name)}</b> <span class="muted">${esc(c.desc)}</span></button>`).join('');
      slash.querySelectorAll('[data-cmd]').forEach(b => b.onmousedown = e => { e.preventDefault(); ta.value = s.draft = '/' + b.dataset.cmd + ' '; showSlash(); ta.focus(); });
    };
    showSlash();
    ta.oninput = () => { s.draft = ta.value; showSlash(); };
    if (caret && caret.id === s.id) { const c = caret.n ? p.querySelector(`[data-question] [name="${caret.n}"]`) : ta; if (c) { c.focus(); c.setSelectionRange(caret.s, caret.e); } else ta.focus(); } // CP9: the answered question's field is gone
    // note 8: while a turn runs, Enter queues the message; Ctrl Enter (or Ctrl click) interrupts and sends it now.
    // 2026-10-24: a live chat sends at once, and the daemon puts it into the running turn; it queues only behind messages
    // already queued, or when the daemon refuses it mid-turn (liveChat.prompt).
    // CP1: mid-turn, when says how (composer.mjs): Enter or Steer steers it in after the current step, Tab or Queue sends it after the turn.
    const go = (now, when) => { const t = ta.value.trim(); if (!canSend(s, t, now)) return; s.draft = ''; sendText(s, t, now, when); if (bare && outer.settings.closeOnSend) outer.closeModal(); };
    const stopTurn = () => { cancelTurn(s); outer.renderTabs(); renderChats(); };
    ta.onkeydown = e => {
      if ((e.key === 'Tab' || e.key === 'Enter' && ta.value !== '/' + slash.querySelector('[data-cmd]')?.dataset.cmd) && !e.shiftKey && !slash.hidden) { e.preventDefault(); slash.querySelector('[data-cmd]').onmousedown(e); return; }
      // Tab with an empty box still moves focus on.
      const key = busy(s) && !s.readonly && turnKey(e);
      if (key === 'cancel') { e.preventDefault(); e.stopPropagation(); return stopTurn(); }
      if (key === 'steer' || key === 'queue' && ta.value.trim()) { e.preventDefault(); return go(false, key); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(e.ctrlKey || e.metaKey); }
    };
    p.querySelector('[data-send]').onclick = e => go(e.ctrlKey || e.metaKey);
    p.querySelectorAll('[data-when]').forEach(b => b.onclick = () => go(false, b.dataset.when));
    p.querySelectorAll('[data-cancel]').forEach(b => b.onclick = stopTurn);
    p.querySelectorAll('[data-restart-p9]').forEach(b => b.onclick = () => outer.restartP9(b));
    // PH5: the daemon stops the chat and opens a terminal with the command typed in; the dock shows that terminal.
    p.querySelectorAll('[data-handoff]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      const r = await outer.liveChat.call('handoff', { id: s.id });
      if (!r.body?.terminal) { if (r.body?.command) { s.events.push({ t: 'notice', text: 'The terminal did not open. Run this in a terminal in the chat folder to continue: ' + r.body.command }); renderChats(); } b.disabled = false; return; }
      outer.showTerminal(r.body.terminal);
    });
    // D14: main moves the chat over its own tunnel (desktop/move.mjs); the moving, moved and move-failed events say how it went.
    p.querySelectorAll('[data-send-away]').forEach(b => b.onclick = () => outer.leave(s));
    // D7: "not signed in" opens the setup wizard at its agents step (browser sign-in, or sign-in in a P9 terminal).
    // Item 15: by name (the pick step now comes first), with the chat's own agent on the step even when it was not picked.
    p.querySelectorAll('[data-signin]').forEach(b => b.onclick = () => outer.welcome('agents', /^Codex/.test(b.parentElement.textContent) ? 'codex' : 'claude', true));
    p.querySelectorAll('[data-copycode]').forEach(b => b.onclick = () => copy(b.nextElementSibling.textContent, b));
    p.querySelectorAll('[data-artifact]').forEach(b => b.onclick = () => openArtifact({ ...chipArtifact(b), sid: s.id }));
    p.querySelectorAll('[data-open-plan]').forEach(b => b.onclick = () => openPlan(s, b.dataset.openPlan));
    p.querySelectorAll('[data-unhold]').forEach(b => b.onclick = () => outer.liveChat.call('unhold', { id: s.id, held: b.dataset.unhold }));
    p.querySelectorAll('[data-qdel]').forEach(b => b.onclick = () => { s.queue.splice(+b.dataset.qdel, 1); keepQueue(s); renderChats(); });
    p.querySelectorAll('[data-qnow]').forEach(b => b.onclick = () => { const [t] = s.queue.splice(+b.dataset.qnow, 1); keepQueue(s); interrupt(s, t); });
    // The Mode, Model and Effort pills each open their menu (#pillMenu, outside the panes; the pill menu code above pane).
    p.querySelectorAll('[data-pill]').forEach(b => b.onclick = () => PM.btn === b ? closePill() : openPill(b, s, b.dataset.pill));
    p.querySelector('[data-attach]').onclick = () => pickImages(s);
    // A pasted screenshot or files dropped anywhere on the chat attach like the paperclip; pasted text pastes as before.
    ta.onpaste = e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addImages(s, files); } };
    p.ondragover = e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); };
    p.ondrop = e => { const files = [...e.dataTransfer.files]; if (files.length) { e.preventDefault(); addImages(s, files); } };
    p.querySelectorAll('[data-unattach]').forEach(b => b.onclick = () => { s.images.splice(+b.dataset.unattach, 1); renderChats(); });
    const more = p.querySelector('[data-earlier]'); if (more) more.onclick = async () => {
      if (s.fetching) return;
      const h = p.querySelector('.hist'), below = h.scrollHeight - h.scrollTop;
      if (s.more !== undefined && s.events.filter(e => e.t !== 'approval' && e.t !== 'question').length < (s.tail || TAIL) + TAIL) { s.fetching = true; try { await earlier(s); } finally { s.fetching = false; } }
      s.tail = (s.tail || TAIL) + TAIL; renderChats(); h.scrollTop = h.scrollHeight - below;
    };
    const st = p.querySelector('[data-start]'); if (st) st.onclick = () => { s.state = 'running'; s.events.push({t:'notice', text:'Connected over ACP · ' + s.model}); outer.renderTabs(); renderChats(); };
    const stop = p.querySelector('[data-stop]'); if (stop) stop.onclick = () => stopChat(s);
    const res = p.querySelector('[data-resume]'); if (res) res.onclick = () => { if (s.live) return p.querySelector('textarea').focus(); s.state = 'running'; s.readonly = false; s.events.push({t:'notice', text:'Resumed natively (session/resume).'}); outer.renderTabs(); renderChats(); };
    const cf = p.querySelector('[data-chat-files]'); if (cf) cf.onclick = () => outer.side.current()?.slot === 'chat-files' && CF.sid === s.id ? outer.side.close('chat-files') : openChatFiles(s.id);
    p.querySelector('[data-steps]').onclick = () => { outer.hideSteps = !outer.hideSteps; localStorage.setItem('p9-hide-steps', outer.hideSteps ? '1' : '0'); renderChats(); };
    const ph = p.querySelector('[data-phone]'); if (ph) ph.onclick = () => continueOnPhone(s);
  });
}
function answered(s) {
  if (outer.mdl.open && outer.S.modal?.kind === 'chat' && outer.S.modal.id === s.id) outer.closeModal();
  outer.renderTabs(); renderChats(new Set([s.id]));
}
// Paperclip (Builder, 2026-10-17: it only drew a blue square). Threat model row 20; the daemon checks the same limits.
function pickImages(s) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: IMG_OK.join(','), multiple: true });
  input.onchange = () => addImages(s, input.files);
  input.click();
}
// The paperclip, a pasted screenshot and dropped files all come through here (Builder, 2026-10-18: "not paste the screenshots").
async function addImages(s, files) {
  for (const file of files) {
    if ((s.images ||= []).length >= MAX_IMAGES) { outer.toast({ kind: 'not attached', txt: 'Four images a message at most.', level: 'warn' }, true); break; }
    try { s.images.push(await readImage(file)); }
    catch (e) { outer.toast({ kind: 'not attached', txt: file.name + ': ' + (e?.message || e) + '.', level: 'warn' }, true); }
  }
  renderChats();
}
// The composer's send (go) and an artifact's Send comments (item 19) share it: queued behind a running turn, or sent.
const canSend = (s, t, now) => !!s && !((!t && !(s.images?.length && (!busy(s) || now))) || s.readonly || s.state === 'moving' || s.state === 'moved');
function sendText(s, t, now, when) {
  const mid = !now && busy(s);
  if (!now && (s.live ? s.queue.length : busy(s))) { s.queue.push(t); keepQueue(s); renderChats(); return; }
  (now ? interrupt : outer.startTurn)(s, t, mid ? when || 'steer' : undefined);
}
// Builder, 2026-10-21 (an interrupt-and-send message was lost): the daemon refuses a prompt while the cancelled turn is
// still ending (409 turn-running), so a live chat puts the message first in the queue and turn-end sends it.
function interrupt(s, t) {
  if (!busy(s)) return outer.startTurn(s, t);
  if (s.live) { s.queue.unshift(t); keepQueue(s); cancelTurn(s); renderChats(); return; }
  cancelTurn(s); outer.startTurn(s, t);
}
function cancelTurn(s, quiet) {
  // CP7: no turn to cancel (it ended, or its end never came) means idle: the chat stops showing working and an
  // interrupt's message, queued first, goes now.
  if (s.live) { if (!quiet) outer.liveChat.call('cancel', { id: s.id }).then(r => { if (r.status === 409 && r.body?.error === 'no-turn') { s.working = s.prompted = false; turnEnd(s); } }); return; }
  s.turn = (s.turn || 0) + 1; s.streaming = false; // stale timers see a new turn number and stop
  s.events = s.events.filter(e => !(e.t === 'tool' && e.status === 'in_progress'));
  if (!quiet) s.events.push({t:'notice', text:'Turn cancelled.'});
}
// The end of a turn applies a queued mode, then sends the next queued message.
// Threat model row 21 (Builder, 2026-10-18: no notice when a turn ended): a live turn-end nobody is watching leaves an
// "<agent> finished" card, and a desktop notice while the window is in the background. Only P9's words, never reply text.
function finished(s) {
  if (s.queue.length) return;
  const onScreen = document.hasFocus() && (outer.S.focus === 'chat' && (outer.S.split ? outer.S.open.slice(0, 2) : outer.S.open.slice(0, 1)).includes(s.id) || outer.mdl.open && outer.S.modal?.kind === 'chat' && outer.S.modal.id === s.id);
  if (onScreen) return;
  s.done = true; outer.keepUnseen();
  if (!document.hasFocus() && typeof Notification === 'function') { const n = new Notification(outer.names[s.agent] + ' finished', { body: s.title }); n.onclick = () => { window.focus(); outer.openModal({ kind: 'chat', id: s.id }, 'done' + s.id); }; }
}
function turnEnd(s) {
  autoArtifact(s);
  if (s.modeNext) { setMode(s, s.modeNext); s.modeNext = null; s.events.push({t:'notice', text:'Mode is now ' + modeNow(s) + '.'}); }
  if (s.queue.length) { const t = s.queue.shift(); keepQueue(s); outer.startTurn(s, t); } else { outer.renderTabs(); renderChats(new Set([s.id])); } // an interrupt may queue '' (images only)
}
function reply(s, text) {
  const turn = s.turn = (s.turn || 0) + 1; s.streaming = true;
  outer.setTimeout(() => { if (s.turn !== turn) return; s.events.push({t:'agent', text:''}); const ev = s.events[s.events.length - 1]; let i = 0;
    const tick = () => { if (s.turn !== turn) return; i += 3; ev.text = text.slice(0, i); if (i < text.length) { renderChats(); outer.setTimeout(tick, 18); } else { s.streaming = false; turnEnd(s); } }; tick(); }, 500);
}
const dataNote = () => { outer.$('#dataNote').textContent = [outer.live.on && !outer.serverInfo?.slim && 'Mission Control live', outer.liveChat.on && 'Chat live', !outer.liveChat.on && (outer.sampleView ? 'Chat sample data' : 'Chat waiting for the daemon'), outer.sampleView && 'Dev sample data'].filter(Boolean).join(' · '); };
const chatModel = { claude: 'Claude Code · ACP', codex: 'Codex · ACP' };
const textLines = t => typeof t === 'string' && t ? t.replace(/\n$/, '').split('\n') : [];
const toolDiff = content => { const rows = (content || []).filter(c => c.type === 'diff').flatMap(c => lineDiff(textLines(c.oldText), textLines(c.newText))).slice(0, 200); return rows.length ? rows : null; };
// PH1: the phone link for this chat, on the daemon's own remote address (its --remote-origin, none with remote logins off).
async function continueOnPhone(s) {
  const r = await window.p9?.chat?.('missionFiles', {}).catch(() => null);
  outer.$('#phoneBody').innerHTML = phoneDialogBody(r?.status === 200 ? r.body.remoteOrigin : '', s.id);
  outer.$('#phoneDlg').showModal();
}
// A web link in a reply (made by helpers.mjs mdReply, row 18): the window never navigates, so main opens it in the browser,
// after a question showing the whole address (Builder, 2026-11-02: the chat link confirm, "yes on 1.6"); "don't ask again"
// is kept on this computer.
const linkOk = href => localStorage.getItem('p9-link-ok') ? Promise.resolve(true) : new Promise(done => {
  const d = outer.$('#linkDlg'); outer.$('#linkU').textContent = href; d.returnValue = '';
  d.onclose = () => { if (d.returnValue === 'never') localStorage.setItem('p9-link-ok', '1'); done(d.returnValue === 'yes' || d.returnValue === 'never'); };
  d.showModal();
});
// Chat files: the files an edit call (Write, Edit, NotebookEdit; ACP kind edit, both adapters) wrote, from its rawInput, locations
// and diffs, as the agent named them (absolute, or relative to the chat's folder). Created: a diff with no old text, else a Write.
// ponytail: a Write over a file that was already there, with no diff, reads as created.
// Each file keeps its own line diff for the Changes tab (an update with no content keeps the one it had).
// ponytail: up to 2,000 rows a file, against the chat's 200.
const editFiles = (d, tool) => {
  if (tool.kind !== 'edit') return tool.files;
  const diffs = (Array.isArray(d.content) ? d.content : []).filter(c => c?.type === 'diff' && typeof c.path === 'string');
  const rows = p => { const r = diffs.filter(c => c.path === p).flatMap(c => lineDiff(textLines(c.oldText), textLines(c.newText))).slice(0, 2000); return r.length ? r : tool.files?.find(f => f.path === p)?.diff; };
  const paths = [d.rawInput?.file_path, d.rawInput?.notebook_path, ...(Array.isArray(d.locations) ? d.locations.map(l => l?.path) : []), ...diffs.map(c => c.path), ...(tool.files ?? []).map(f => f.path)].filter(p => typeof p === 'string' && p);
  const created = p => { const c = diffs.find(c => c.path === p); return c ? c.oldText == null || c.oldText === '' : tool.files?.find(f => f.path === p)?.created ?? /^Write\b/.test(tool.title); };
  return paths.length ? [...new Set(paths)].slice(0, 50).map(p => ({ path: p, created: created(p), diff: rows(p) })) : tool.files;
};
const toolText = content => (content || []).filter(c => c.type === 'content' && c.content?.type === 'text').map(c => c.content.text).join('\n').slice(-4000);
// Item 19, plan view: Claude's plan-mode plan (ExitPlanMode: the adapter's "Approve Plan" call, kind switch_mode), kept whole.
const planText = d => d?.kind === 'switch_mode' && (d.content || []).filter(c => c.type === 'content' && c.content?.type === 'text').map(c => c.content.text).join('\n').slice(0, 200000) || undefined;
// A live chat's queued messages are kept per conversation, so a window restart shows them again and still sends them.
// ponytail: this window's storage only; the phone and a second desktop do not see them (a daemon-side queue would).
const keepQueue = s => { if (!s.live) return; try { s.queue.length ? localStorage.setItem('p9-queue:' + s.id, JSON.stringify(s.queue)) : localStorage.removeItem('p9-queue:' + s.id); } catch {} };
const keptQueue = id => { try { const q = JSON.parse(localStorage.getItem('p9-queue:' + id)); return Array.isArray(q) ? q.filter(t => typeof t === 'string') : []; } catch { return []; } };
const liveSession = (id, provider, title, folder, created, project = null, profile = null) => ({ id, agent: provider, title, project, profile, model: profile?.model || chatModel[provider], mode: outer.startMode(provider), queue: keptQueue(id), effort: 'Medium', state: 'idle', pending: null, context: null, limits: { h5: 0, d7: 0 }, cacheMin: null, cwd: folder || 'P9 workspace', folder: folder || '', events: [], live: true, created });
// E2: a chat that was stopped at launch is only listed (stub); its events load the first time it is shown, or before
// the next event for it is applied. Up to until, so nothing the main loop applies comes twice; retried until it loads.
function history(s, until = outer.liveChat.cursor) {
  return s.loading ||= (async () => {
    for (let after = 0; !outer.lifetime.signal.aborted;) {
      const r = await window.p9.chat('events', { after, only: [s.id], until, ...(after ? {} : { tail: TAIL }) });
      // ponytail: refused (an ID that is not a UUID, which only a seeded test ledger has) leaves the chat empty, not stuck.
      if (r.status === 400) break;
      if (r.status !== 200) { await new Promise(res => outer.setTimeout(res, 2000)); continue; }
      for (const ev of r.body.events) try { applyChat(ev); } catch {}
      if (r.body.more) { tailed(s, r.body); break; }
      after = r.body.cursor;
      if (r.body.events.length < 500) break;
    }
    s.stub = false; outer.renderTabs(); renderChats();
  })();
}
// P20 on the desktop: a chat loads with its newest TAIL blocks (the daemon's ledger.tail), not its whole history, which
// over a remote's ssh link took minutes. s.more is the first cursor loaded when older events were left out; s.early, the
// older events that came along anyway (cards, the latest mode, plan and commands), so Show earlier does not add them twice.
// A daemon without tail sends no more, and the chat loads whole, as before.
// ponytail: those early events show above the loaded blocks, not in their place, as on the phone.
function tailed(s, body) {
  const from = body.more?.[s.id];
  s.more = from;
  s.early = new Set([...(s.early ?? []), ...(from === undefined ? [] : body.events.filter(e => e.conversation === s.id && e.cursor < from).map(e => e.cursor))]);
}
async function earlier(s) {
  const r = await window.p9.chat('events', { after: 0, only: [s.id], until: s.more - 1, tail: TAIL });
  if (r.status !== 200) return;
  const old = { ...liveSession(s.id, s.agent, s.title, s.folder, 0), queue: [] };
  for (const ev of r.body.events) if (!s.early?.has(ev.cursor)) try { applyChat(ev, old); } catch {}
  s.events = [...old.events, ...s.events];
  tailed(s, r.body);
}
// Applies one daemon event to S (or to into, Show earlier's older blocks); returns the session when a turn ended (so queued messages can go).
function applyChat(ev, into) {
  const d = ev.data;
  if (ev.type === 'created') { if (!into && !outer.S.sessions.some(x => x.id === ev.conversation)) { const s = liveSession(ev.conversation, d.provider, d.title, d.folder, ev.at, d.project, d.profile); outer.claimFresh(s, d.op); outer.S.sessions.push(s); } return null; }
  const s = into ?? outer.S.sessions.find(x => x.id === ev.conversation); if (!s) return null;
  // Last used, as the daemon's list counts it (History's order); a stub's older history can load after newer events.
  if (!NOT_USE.includes(ev.type)) s.used = Math.max(s.used || 0, ev.at);
  const last = s.events[s.events.length - 1], notice = text => s.events.push({ t: 'notice', text });
  const settle = () => { s.working = s.prompted = false; s.pending = null; s.events = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'); };
  switch (ev.type) {
    case 'user': if (typeof d.note === 'string') notice('P9 told the agent: ' + d.note.trim()); s.events.push({ t: 'user', text: d.text, images: d.images, when: new Date(ev.at).toTimeString().slice(0, 5) }); if (!s.profile?.gone) s.state = 'running'; s.working = s.prompted = s.sent = true;
      if (Array.isArray(d.held)) s.held = s.held?.filter(h => !d.held.includes(h.id)); break;
    // CP1: a message the daemon holds for this turn (composer.mjs), and its going back: taken back with its x or by a
    // cancel (loadChat puts the text back in the box), or not sent at all.
    case 'held': (s.held ||= []).push({ id: d.id, text: d.text, when: d.when }); break;
    case 'unheld': s.held = s.held?.filter(h => h.id !== d.id); if (d.why !== 'removed' && d.why !== 'cancelled') notice('Not sent (' + d.why + '): ' + d.text); break;
    case 'connected': notice('Connected over ACP'); s.state = 'running'; s.session = d.session; break;
    // O32: the model the resumed session is really on, so a change shows (the Model pill follows the config event after it).
    case 'resumed': notice('Resumed natively (session/resume)' + (typeof d.model === 'string' ? ' on ' + d.model : '')); if (Array.isArray(d.restoreNotice) && d.restoreNotice.length) notice('Could not restore ' + d.restoreNotice.join(', ')); s.state = 'running'; s.session = d.session; break;
    // The mode the daemon last set for this chat (the phone's own rule), so after a restart or an update the Mode pill, and
    // the mode each message sends, are the chat's own and not a new chat's. The lock's mode is the lock's, not the chat's.
    case 'mode': if (!into && !d.lock && modes[s.agent]?.includes(d.name)) s.mode = d.name; break;
    case 'moving': settle(); s.state = 'moving'; notice('Moving to the remote: this chat is paused here.'); break;
    case 'moved': s.state = 'moved'; s.movedTo = d.host; notice('Moved to ' + d.host + '. It carries on there: switch to Remote mode (the title-bar badge) and open it.'); break;
    case 'move-failed': s.state = 'stopped'; notice('Not moved' + (d.message ? ': ' + d.message : '.') + ' Send a message to carry on here.'); break;
    case 'moved-in': notice('Moved here from another computer. Send a message to carry on where it left off.'); break;
    case 'handed-off': notice('Handed off: press Enter in the terminal to start Claude Code Remote Control, then open this session in claude.ai or the Claude app. Resume here only after you end it there.'); break;
    case 'card': case 'unpin': applyCard(s, ev.type, d); break; // AR2: pin_card and unpin_card, pinned above the composer
    case 'config': s.modelsAt = ev.at; if (!into && !s.profile) outer.newLists(s.agent, ev.at, Array.isArray(d.model?.options) && d.model, Array.isArray(d.pickers) && d.pickers);
      if (Array.isArray(d.model?.options)) { s.models = d.model; s.model = d.model.options.find(o => o.value === d.model.current)?.name || s.model; if (s.modelPick === d.model.current) s.modelPick = null; }
      if (Array.isArray(d.pickers)) { s.pickers = d.pickers; for (const p of d.pickers) if (s.pick?.[p.id] === p.current) delete s.pick[p.id]; }
      break;
    case 'update':
      // Claude Code also runs turns nobody prompted (the continuation after a compaction, a background task's report): no
      // 'user' starts them and no 'turn-end' closes them. Agent output marks the chat working; that turn's closing
      // usage_update (the one with a cost) marks it done.
      if (s.state === 'running' && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(d.sessionUpdate)) s.working = true;
      else if (d.sessionUpdate === 'usage_update' && d.cost && !s.prompted) s.working = false;
      // Every agent request reads and re-warms the prompt cache, so the cache clock starts again from any agent output: a
      // turn nobody prompted (owner, 2026-10-25: a background task's wake-up left the clock at 57 min) and a long prompted
      // turn alike (an agent working on its own for hours inside one turn left it cold); turn-end sets it once more.
      if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(d.sessionUpdate)) s.lastEnd = ev.at;
      if (d.sessionUpdate === 'agent_message_chunk' || d.sessionUpdate === 'agent_thought_chunk') {
        const t = d.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought', text = d.content?.type === 'text' ? d.content.text : '', img = t === 'agent' && imgSrc(d.content), warn = t === 'agent' && agentWarning(text);
        if (warn) s.events.push({ t: 'warn', text: warn }); // the adapter's warning, a notice line above the reply (helpers.mjs)
        else if (last?.t === t) { last.text += text; if (img) (last.images ||= []).push(img); } else s.events.push({ t, text, ...(img && { images: [img] }) });
      } else if (d.sessionUpdate === 'tool_call') { const tool = { t: 'tool', id: d.toolCallId, status: typeof d.status === 'string' ? d.status : 'pending', title: String(d.title || 'Tool call'), kind: d.kind, diff: toolDiff(d.content), output: toolText(d.content), images: toolImages(d.content), plan: planText(d) }; tool.files = editFiles(d, tool); s.events.push(tool); }
      else if (d.sessionUpdate === 'tool_call_update') { const tool = s.events.find(e => e.t === 'tool' && e.id === d.toolCallId); if (tool) { if (typeof d.status === 'string') tool.status = d.status; if (d.title) tool.title = String(d.title); if (typeof d.kind === 'string') tool.kind = d.kind; tool.files = editFiles(d, tool); if (d.content) { tool.diff = toolDiff(d.content); tool.output = toolText(d.content); tool.images = toolImages(d.content); } } }
      else if (d.sessionUpdate === 'available_commands_update' && Array.isArray(d.availableCommands)) s.commands = outer.lastCommands[s.agent] = d.availableCommands.slice(0, 1000).map(c => ({ name: String(c?.name ?? ''), desc: String(c?.description ?? '') })).filter(c => c.name);
      else if (d.sessionUpdate === 'session_info_update' && typeof d.title === 'string' && d.title.trim()) s.title = d.title.replace(/\s+/g, ' ').trim().slice(0, 120);
      else if (d.sessionUpdate === 'usage_update' && d.size > 0) { s.context = { used: Number(d.used) || 0, size: Number(d.size) }; if (d._meta?.['_claude/rateLimit']) outer.usageNow(); }
      else if (d.sessionUpdate === 'plan') { const entries = (Array.isArray(d.entries) ? d.entries : []).map(x => [String(x?.status), String(x?.content ?? '')]), plan = s.events.find(e => e.t === 'plan'); if (plan) plan.entries = entries; else s.events.push({ t: 'plan', entries }); }
      break;
    case 'approval': s.events.push({ t: 'approval', request: d.request, title: d.toolCall?.title || 'Tool call', diff: toolDiff(d.toolCall?.content) || [], options: d.options.map(o => [o.optionId, o.name, o.kind]), plan: planText(d.toolCall) }); s.pending = 'approval'; break;
    case 'question': {
      // The daemon's form (formSpec in chat.mjs) is the one P9 renders and checks; null means P9 cannot show it faithfully.
      // A required choice starts unpicked; an optional one starts on "No answer" (left out of the reply).
      const field = f => {
        const radio = options => f.required ? { kind: 'radio', options, def: null } : { kind: 'radio', options: [['', 'No answer'], ...options], def: '' };
        const shape = f.kind === 'choice' ? radio(f.options) : f.kind === 'boolean' ? radio([['true', 'Yes'], ['false', 'No']]) : f.kind === 'multi' ? { kind: 'multi', options: f.options } : { kind: 'text' };
        return { ...shape, key: f.key, label: f.label, hint: f.hint, required: f.required, type: f.kind };
      };
      s.events.push({ t: 'question', request: d.request, title: d.message, unsupported: !d.form, fields: d.form ? d.form.fields.map(field) : [] }); s.pending = 'question'; break; }
    case 'answered': s.events = s.events.filter(e => e.request !== d.request); s.pending = s.events.some(e => e.t === 'approval') ? 'approval' : s.events.some(e => e.t === 'question') ? 'question' : null;
      notice(d.answer.outcome ? (d.answer.outcome.outcome === 'selected' ? 'You chose: ' + d.answer.outcome.optionId : 'Approval cancelled') : 'Question: ' + d.answer.action); break;
    case 'lock-rejected': notice('Agent lock: rejected ' + (d.toolCall?.title || 'a tool call')); break;
    case 'restart-request': s.events.push({ t: 'notice', text: 'The agent asks you to restart P9: ' + d.reason, restart: true }); break; // RS2: with a Restart button
    case 'steer-lost': notice('This message may not have reached the agent: ' + d.text); break;
    case 'turn-end': settle(); s.lastEnd = ev.at; outer.usageNow(); outer.queueSoon(); if (d.stopReason !== 'end_turn') notice('Turn ended: ' + d.stopReason); return s;
    case 'error': s.events.push({ t: 'error', text: d.message }); s.working = false; break;
    // N1: the daemon's word on a chat's project, title, archive and removal, for every window (apps/server/projects.mjs).
    case 'project': s.project = d.project ?? null; break;
    case 'renamed': s.title = d.title; break;
    case 'archived': s.archived = !!d.archived; break;
    case 'deleted': if (!into) { outer.S.sessions = outer.S.sessions.filter(x => x !== s); outer.S.open = outer.S.open.filter(x => x !== s.id); } break;
    case 'exited': settle(); s.state = 'stopped'; notice('The agent process exited' + (d.code != null ? ' (code ' + d.code + ')' : '') + '. Send again to resume.'); break;
    case 'stopped': settle(); s.state = 'stopped'; notice(d.result === 'stopped' ? 'Stopped. Everything this session started has ended.' : 'Stop could not confirm that everything ended.'); break;
    case 'interrupted': settle(); s.state = 'stopped'; notice('Interrupted: the P9 daemon restarted mid-turn. Send again to resume.');
      for (const h of s.held?.splice(0) ?? []) notice('Not sent (the daemon restarted): ' + h.text); break; // held only in the daemon's memory
  }
  return null;
}
async function loadChat() {
  if (!window.p9?.chat) return;
  // E2: launch replays only the chats that are not stopped (a 110 MB ledger was all replayed before); the rest are
  // listed after it as stubs. ponytail: over 100 such chats it replays everything, as before (their IDs go in the URL).
  let replaying = true, scope = null, listed = [];
  // O47: the list reply carries each agent's lists; while the daemon reads them fresh, ask again until it is done.
  let asking = false;
  const lists = async body => { if (!outer.takeLists(body?.lists) || asking) return; asking = true;
    for (let i = 0; i < 60 && !outer.lifetime.signal.aborted; i++) { await new Promise(res => outer.setTimeout(res, 1500)); const l = await window.p9.chat('list', {}); if (l.status === 200 && !outer.takeLists(l.body.lists)) break; }
    asking = false; refreshPill(); renderChats();
    // Settings or the New menu open while the lists were read: the Default model and effort rows, and the menu's rows, fill in.
    if (outer.$('#setDlg')?.open) outer.refreshDefaults();
    const pop = outer.$('#newPop'); if (pop && !pop.hidden) { const at = pop.querySelector('[data-new]:focus'); outer.newRows(); if (at) pop.querySelector(`[data-new="${at.dataset.new}"]${at.dataset.model ? `[data-model="${at.dataset.model}"]` : ':not([data-model])'}`)?.focus(); } };
  const list = async () => { let l; while ((l = await window.p9.chat('list', {})).status !== 200 && !outer.lifetime.signal.aborted) await new Promise(res => outer.setTimeout(res, 2000)); lists(l.body); await outer.loadProfiles(); return l.body?.conversations || []; };
  while (!outer.lifetime.signal.aborted) {
    const l = scope ? null : await window.p9.chat('list', {});
    if (l?.status === 200) { lists(l.body); listed = l.body.conversations; const ids = listed.filter(c => c.state !== 'stopped' && c.state !== 'moved').map(c => c.id); scope = ids.length <= 100 ? { only: ids } : {}; }
    // P20: the first replay reads each open chat's newest blocks only (tailed, above).
    const tail = replaying && scope?.only && !outer.liveChat.cursor ? { tail: TAIL } : {};
    const r = scope ? await window.p9.chat('events', { after: outer.liveChat.cursor, ...(replaying ? { ...scope, ...tail } : { wait: 8000 }) }) : l;
    // A refused narrowed replay (a listed ID the bridge or daemon will not take) replays everything, as before E2.
    if (r.status === 400 && replaying && scope?.only) { scope = {}; continue; }
    if (r.status !== 200) { if (!outer.liveChat.on && outer.sampleView) return; await new Promise(res => outer.setTimeout(res, outer.liveChat.on ? 2000 : 5000)); continue; }
    if (!outer.liveChat.on) { outer.liveChat.on = true; outer.S.sessions = []; outer.S.open = []; dataNote(); }
    // A tail can leave out a chat's created event, so its tab comes from the list.
    if (r.body.more) for (const c of listed) if (scope.only.includes(c.id) && !outer.S.sessions.some(s => s.id === c.id)) outer.S.sessions.push({ ...liveSession(c.id, c.provider, c.title, c.folder, c.created, c.project, c.profile), archived: c.archived });
    const ended = [], answered_ = [];
    for (const ev of r.body.events) {
      const created = ev.type === 'created' && !replaying, stub = outer.S.sessions.find(s => s.id === ev.conversation && s.stub);
      if (stub) try { await history(stub, ev.cursor - 1); } catch (e) { console.error('chat history', e); }
      // A malformed stored event is skipped, never thrown: it would fail again on every replay.
      let end = null; try { end = applyChat(ev); } catch { end = null; } if (end) ended.push(end);
      if (created && !swapIn(ev.conversation)) show(ev.conversation);
      // N1: failed (a red cross on the row and the strip) until it is seen; never from a replay, which is history.
      if (!replaying && (ev.type === 'error' || (ev.type === 'exited' && ev.data?.code))) { const f = outer.S.sessions.find(x => x.id === ev.conversation); if (f) { f.failed = true; outer.keepUnseen(); } }
      if (!replaying && (ev.type === 'project' || ev.type === 'deleted' || (ev.type === 'created' && ev.data?.project))) outer.loadProjects?.();
      if (ev.type === 'answered') answered_.push(ev.conversation);
      // CP1: a held message taken back goes into the box, as typed (not on replay: the box keeps its own draft).
      // ponytail: its images are not returned; attach them again.
      const back = !replaying && ev.type === 'unheld' && ['removed', 'cancelled'].includes(ev.data?.why) && outer.S.sessions.find(s => s.id === ev.conversation);
      if (back) back.draft = ev.data.text + (back.draft ? '\n' + back.draft : '');
      // Its x in any window takes the tab out of this one too (not on replay, which hides every stopped chat).
      const closed = !replaying && ev.type === 'closed' && outer.S.sessions.find(s => s.id === ev.conversation && !s.hidden);
      if (closed) { closed.hidden = true; untab(closed.id); }
    }
    outer.liveChat.cursor = r.body.cursor;
    if (r.body.more) for (const s of outer.S.sessions) if (scope.only.includes(s.id)) tailed(s, r.body);
    if (replaying && (r.body.more || r.body.events.length < 500)) {
      replaying = false;
      // Tabs keep the order the chats were made in; History sorts by last used.
      const all = (await list()).sort((a, b) => a.created - b.created), have = new Map(outer.S.sessions.map(s => [s.id, s]));
      outer.S.sessions = [...all.map(c => { const h = have.get(c.id); if (h && c.profile) h.profile = c.profile; return h || { ...liveSession(c.id, c.provider, c.title, c.folder, c.created, c.project, c.profile), state: c.state, stub: true, sent: c.sent, used: c.used }; }), ...outer.S.sessions.filter(s => !all.some(c => c.id === s.id))];
      // N1: a chat's project and archive come from the list too (a tailed replay can leave their events out).
      for (const c of all) { const s = have.get(c.id); if (s) { s.project = c.project ?? null; s.archived = !!c.archived; } }
      outer.loadProjects?.();
      // N1: a result not seen yet (unread or failed) stays unseen over a restart; renderChats saves the list from now on.
      try { const u = JSON.parse(localStorage.getItem('p9-unseen') || '{}'); for (const x of outer.S.sessions) if (u[x.id]) x[u[x.id]] = true; } catch {}
      unseenKept = true;
      // A chat closed here before 0.1.5 that never started stops now, so other windows drop it too; a running one keeps
      // running (the phone may have resumed it) and gets its tab back.
      for (const s of outer.S.sessions) { s.hidden = s.state === 'stopped' || s.state === 'moved'; if (outer.closedChats.has(s.id) && s.state === 'idle') { s.hidden = true; outer.liveChat.stop(s, true); } }
      outer.closedChats.clear(); localStorage.removeItem('eh-closed-chats');
      if (!outer.S.open.length) outer.S.open = outer.S.sessions.filter(s => !s.hidden).slice(-2).reverse().map(s => s.id);
      // Messages kept from before a restart go now: the daemon takes them into a running turn, or queues them back.
      for (const s of outer.S.sessions) if (s.queue.length && s.state === 'running') turnEnd(s);
      outer.moveReloaded();
    }
    // CP9: a throw here (a paint) used to end this loop, so the chat froze until a restart; log it and keep polling.
    else if (!replaying) try { for (const s of ended) { finished(s); turnEnd(s); } for (const id of answered_) { const s = outer.S.sessions.find(x => x.id === id); if (s && !s.pending) answered(s); } } catch (e) { console.error('chat batch', e); }
    try { outer.renderTabs(); renderChats(new Set(r.body.events.map(ev => ev.conversation))); } catch (e) { console.error('chat paint', e); }
  }
}
  return { ART, keepBox, focus, show, stopChat, newSession, pickRemoteFolder, recentFolders, renderNewFolder, usageRows, cacheOf, busy, renderChats, paint, turnEnd, reply, dataNote, linkOk, keepQueue, history, loadChat };
}
