// Chat Focus: artifacts and chat files, chat tabs and the new-chat folder, panes, meters, turns, and the live chat's history from the daemon. Split out of controller.mjs's mountShell (F9) with no change in behaviour; names that stay in mountShell come in through outer.
import { artifactView, artifactsIn, KIND_NAMES, chipArtifact } from './artifact.mjs';
import { pastedFiles, quoted, esc, copy, limitLine, limitLines, paceOf, paceRow, planWindows, svg, agentImgs, warnHtml, modes, dragBar, LOOSE, imgSrc, agentWarning, toolImages, ageOf, exitTag } from './helpers.mjs';
import { pinned, applyCard, isReport, reportKey, SHUT, TUCK } from './pinned.mjs';
// O109: the worker reports the user closed, kept over a restart. ponytail: one short key per closed report, never pruned; fine until thousands.
import { strip, chip, turnKey, diffRows, diffCreated, diffDeleted } from './composer.mjs';
import { LABEL, projectOf } from './panel.mjs'; import { fillLoose } from './security.mjs'; import { NOT_USE } from '../../../packages/protocol/index.mjs';
// The two button looks repeated in the pane's markup, written once (they cost bytes in the startup JS each time).
const GH = 'data-slot="button" data-variant="ghost" data-size="sm"', OL = 'data-slot="button" data-variant="outline" data-size="sm"';

// The ask a chat waits on, by its request (bell-notice.mjs: one its history loaded is old).
export const askId = s => s.events.findLast(e => e.request !== undefined && (e.t === 'approval' || e.t === 'question'))?.request;
// The bell's key for a chat's ask (controller.mjs cardList, bell-notice.mjs): by request, so a new ask of the same kind is new.
export const askKey = s => s.id + (askId(s) ?? s.pending);
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
  const n = art.versions?.length ?? 0, at = n > 1 ? art.versions.findIndex(v => artSig(v) === JSON.stringify([art.kind, art.lang, art.title, art.src])) : -1, step = d => openArtifact({ ...art, ...art.versions[at + d] });
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
// Chat files (a button just left of the running indicator opens a side panel of the chat's artifacts and files).
// The button sits left of the chat's own Running label (pane());
// its panel, the side panel's 'chat-files' slot, has two tabs (the artifacts and the diffs each
// in their own tab), each newest first. Artifacts: every artifact the chat's replies posted (a click opens it as its chip does).
// Changes: every file its finished edit calls wrote (editFiles), created or edited; a click shows that file's diffs, read-only
// ("let me at lease read only the diff"), from the edit calls themselves, so nothing is read from the disk and nothing can be
// applied. The open list and its tab are remembered per chat (localStorage 'p9-chat-files:<id>'): that chat shown again in
// Chat Focus opens it again.
// ponytail: only the chat's loaded events are read (its latest TAIL steps until Show earlier), as the chat itself shows them;
// artifacts are the exception (keptArts, below).
const CF = { sid: null, ws: null, asked: false, html: null, tab: 'artifacts' };
const cfKey = id => 'p9-chat-files:' + id;
// Artifacts outlive the loaded events (they were lost on compact): a chat long enough to compact
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
      const was = seen.get(f.path), item = { type: 'file', at: i, path: f.path, created: f.created, deleted: !!f.deleted };
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
// A worker's notes (sprint spec D4), read-only, as the file is now: read again each time the button opens it.
let notesSid = null;
function openNotes(s) {
  notesSid = s.id;
  outer.side.open('worker-notes', { title: 'Notes · ' + s.title, focuses: ['chat'], defaultWidth: w => w / 3, render: b => {
    const pre = b.appendChild(document.createElement('pre')); pre.dataset.notesText = ''; pre.style.cssText = 'margin:0;padding:12px;white-space:pre-wrap;overflow:auto;height:100%;font:12px/1.5 var(--font-mono,monospace)';
    pre.textContent = 'Reading the notes…';
    window.p9.chat('notes', { id: s.id }).then(r => { pre.textContent = r?.status === 200 ? r.body.text || '(empty)' : r?.status === 404 ? 'This worker has no notes file yet.' : 'The notes could not be read.'; }, () => { pre.textContent = 'The notes could not be read.'; }); },
    onClose: () => queueMicrotask(() => renderChats()) });
  renderChats();
}
// The list itself (its rows, line counts and diffs: MC-13, MC-14) is chat-files.mjs, loaded when the panel first opens, so the
// shell's startup JS stays in its budget (shell-bundle.test.mjs).
const CFM = {};
function renderChatFiles() {
  if (outer.side.current()?.slot !== 'chat-files') return;
  if (!CFM.render) { CFM.load ??= import('./chat-files.mjs').then(m => { CFM.render = m.render; renderChatFiles(); }, () => { CFM.load = null; if (outer.side.current()?.slot === 'chat-files') outer.side.body.textContent = 'The list could not be loaded. Open it again to retry.'; }); return; }
  const s = sess(CF.sid);
  CFM.render({ outer, CF, s, all: s ? chatItems(s) : [], GH, cfKey, openArtifact, again: renderChatFiles });
}
// From renderChats, in Chat Focus: the open list follows its chat (another chat shown hides it, still remembered), and a
// remembered one comes back when its chat is shown and the panel is free.
function chatFilesFollow(ids) {
  if (outer.S.focus !== 'chat') return;
  if (outer.side.current()?.slot === 'chat-files' && !ids.includes(CF.sid)) outer.side.close('chat-files', 'hidden');
  const want = !outer.side.current() && ids.find(id => localStorage.getItem(cfKey(id)) && outer.S.sessions.some(s => s.id === id && !s.stub && chatItems(s).length));
  if (want) openChatFiles(want); else renderChatFiles();
}
function focus(id) { const s = sess(id); if (s?.hidden) s.hidden = false; show(id); outer.renderTabs(); renderChats(); }
// The chat shown goes first and the one before it second, so Split has the last two (replacing only
// the first kept a one-tab start at one open chat, and Split showed one pane).
const show = (id, auto) => { if (!auto) outer.S.nav++; outer.S.view = null; outer.S.open = [id, ...outer.S.open.filter(x => x !== id)].slice(0, 2); if (outer.S.files) outer.renderTree(); }; // Current project files follow the chat shown
// N1: Stop is final (no Undo): on the chat's row and first in its menu (panel.mjs), and in its header. The chat stays in
// the panel's list; a message sent to it starts it again.
function stopChat(s) { if (s.live) return outer.liveChat.stop(s); cancelTurn(s, true); s.state = 'stopped'; s.pending = null; s.events = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'); s.events.push({t:'notice', text:'Stopped. Resume continues the native session.'}); outer.renderTabs(); renderChats(); }
const untab = id => { outer.S.open = outer.S.open.map(o => o === id ? (outer.S.sessions.find(x => !x.hidden && !outer.S.open.includes(x.id)) || {}).id : o).filter(Boolean); outer.renderTabs(); renderChats(); };
let waitingNew = null;
function newSession(agent, model, project = null, profile = '') {
  outer.S.nav++; // O261: a project click still waiting for its code is dropped (the daemon's chat is shown later, as auto)
  outer.usedAgent(agent);
  // Dev Focus had no way to start a new chat: one started from Dev Focus is the chat beside the editor.
  if (outer.S.focus === 'dev') { outer.S.sideId = null; outer.setSideChat(true); }
  if (outer.liveChat.on) return outer.liveChat.create(agent, '', project, model, profile);
  // O57: before the daemon answers there is no model or usage to show, and a chat made here would be dropped once it does.
  // The press is kept and the chat is made on the daemon when it answers (the newest press wins).
  if (!outer.sampleView && window.p9?.chat) { waitingNew = [agent, model, project, profile];
    return outer.toast({ kind: 'chat', txt: 'Connecting to the P9 daemon. Your new chat opens once it answers.', level: 'warn' }, true); }
  const s = { id: 's-' + Date.now(), agent, title: `${outer.names[agent]} ${outer.S.sessions.filter(x => x.agent === agent).length + 1}`, model, mode: outer.startMode(agent), queue: [], effort: 'Medium', state: 'idle', pending: null, context: null, limits: outer.M.sessions?.[agent === 'claude' ? 0 : 1]?.limits ?? { h5: 0, d7: 0 }, cacheMin: null, cwd: outer.M.sessions?.[0]?.cwd ?? 'P9 workspace', events: [] };
  s.project = project; outer.S.sessions.push(s); show(s.id); outer.renderTabs(); renderChats();
}
// U4 on a remote (no window opened, and a normal file picker beats clicking ".." through folders):
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
// Live chats: context from the agent's usage_update, 5 h and 7 d from the daemon's /usage for this agent (a reading over
// an hour old is dimmed), the cache timed from the last turn end (Claude only: its prompt cache lasts an hour).
// One limit window as a bar (chat meters and Mission's Usage panel); an expired window shows a dash.
// Amber from 75% on every bar (MR1).
const HOT = 75;
// mins: the window's length; with it the bar carries the pace tick (where even use would be now, helpers.mjs paceOf).
const meterBar = (label, w, line, now = Date.now(), mins = 0) => { const p = !w || w.resetsAt && w.resetsAt < now ? null : Math.round(w.usedPercent), pace = mins ? paceOf(w, mins, now) : null;
  return `<div class="meter" title="${esc(line.text)}"${line.stale ? ' data-stale' : ''}><div class="l"><span>${label}</span><b>${p == null ? '—' : p + '%'}</b></div><div class="mbar"${pace ? ` data-pace="${pace.state}"` : ''}><div class="fx-meter" ${p >= HOT ? 'data-hot' : ''}><span style="width:${p || 0}%"></span></div>${pace ? `<u class="ptick" style="left:${Math.round(pace.elapsed * 1000) / 10}%"></u>` : ''}</div></div>`; };
// Each agent's plan windows as rows (the Usage window, Mission's Usage card): helpers.mjs paceRow, the phone draws the same.
// USE-1: one row per agent in /usage limits (helpers limitLines: an agent GET /agents has not named shows its id), muted by the daemon's stale mark.
const usageRows = () => { const now = Date.now(), lims = outer.usage.limits; return limitLines(lims, outer.names).filter(l => lims[l.id]).map(l => `<section class="uagent" data-agent="${esc(l.id)}"${l.stale ? ' data-stale' : ''}><h5>${esc(l.name)}<small>${esc((l.shared ? 'shared plan with ' + l.shared + ' · ' : '') + l.text.split(' · ').at(-1))}</small></h5>${planWindows(lims[l.id]).map(([label, w, mins]) => paceRow(label, w, mins, now)).join('')}</section>`).join(''); };
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
// O249: an agent's picture comes as its place (shot:) and is fetched when seen (shots.mjs), which loads with the first chat
// that has one: startup carries none of it. Until it has loaded, every picture draws as its placeholder; a failed load says so
// (noLoad) and is not tried again: the file is local, so it fails when P9 was updated under this window, and a reload fixes it.
let shots; // the loading import, then shots.mjs's desktop {watch(s, scroller)}; a chat's pictures are its own s.shots
function sess(id) { return outer.S.sessions.find(x => x.id === id); } // a chat by id
// Code that loads on first use (shots.mjs, move-fx.mjs) did not load: chat id's chat says so once and redraws (its composer
// too), or a toast when that chat is not known yet (the list not in, or no chat named).
const NO_LOAD = 'Reload P9 (Ctrl R) to finish loading it.';
const noLoad = id => { const s = sess(id); if (!s) return outer.toast({ kind: 'load', txt: NO_LOAD, level: 'bad' });
  if (s.events.at(-1)?.text !== NO_LOAD) s.events.push({ t: 'notice', text: NO_LOAD }); renderChats(); };
const shotSrc = s => src => s.shots?.get(src);
const watchShots = (s, p) => { const h = p.querySelector('.hist'); if (!h) return; if (shots?.watch) return shots.watch(s, h);
  if (h.querySelector('img[data-shot]')) shots ??= import('./shots.mjs').then(m => { shots = m.installShots(renderChats); renderChats(); }, () => noLoad(s.id)); };
// O73: a message another chat's agent sent names that chat: its title when it sent (fromTitle), else its title now, else
// "a deleted chat"; P9's own notes say P9. Drawn apart from the user's own (data-from).
const sentBy = (id, title) => esc(title || (id === 'p9' ? 'P9' : sess(id)?.title) || (typeof id === 'string' ? 'a deleted chat' : 'another chat'));
function event(e, s) {
  switch (e.t) {
    // O109-repeat-visible: a message P9 resent after a restart (repeat: true) says so on its row, as the agent was told.
    case 'user': return `${Array.isArray(e.images) ? `<div class="user-imgs">${e.images.map(i => `<img data-chat-img="${esc(i.hash)}"${outer.chatImgs.get(i.hash) ? ` src="${outer.chatImgs.get(i.hash)}"` : ''} alt="Sent image">`).join('')}</div>` : ''}<div class="msg user"${e.ask ? ' data-ask-msg' : ''}${e.ask || e.info || e.from ? ' data-from' : ''}><div class="who"${e.repeat ? ' data-repeat' : ''}>${e.ask ? 'Question from ' + sentBy(e.ask, e.fromTitle) + ' · answered read-only' : e.info ? 'Note from ' + sentBy(e.info, e.fromTitle) + ' · information only' : e.from ? 'Message from ' + sentBy(e.from, e.fromTitle) : 'You'}${e.when ? ' · ' + esc(e.when) : ''}${e.repeat ? ' · sent again after a restart, may be a repeat' : ''}</div>${esc(e.text)}${e.images ? `<div class="xs muted" style="margin-top:6px">📎 ${esc(e.images.length ?? e.images)} image${(e.images.length ?? e.images) > 1 ? 's' : ''}</div>` : ''}${Array.isArray(e.files) && e.files.length ? `<div class="xs muted" data-sent-files>📎 ${e.files.map(f => esc(f?.name)).join(', ')}</div>` : ''}</div>`;
    // O109: a worker report scrolls with the chat once it is not the one pinned above the box (closed, or a newer one came).
    case 'report': { const c = s.cards?.get(e.id), on = c && c.text === e.text && s.events.findLast(x => x.t === 'report') === e && !SHUT.get().has(reportKey(s, c)) && !shelved(e.id);
      return on ? '' : `<div class="report" data-report="${esc(e.id)}"><div class="eyebrow">Worker report</div><div class="msg agent">${outer.mdOf(e)}</div></div>`; }
    case 'agent': return `<div class="msg agent${s.mark?.ev === e ? ' quote-src' : ''}"><div class="who">${esc(outer.names[s.agent])}${e.text ? '<button class="quote-reply" data-quote-reply title="Quote this reply in your message" aria-label="Quote this reply"></button>' : ''}</div>${outer.mdOf(e)}${agentImgs(e.images, outer.names[s.agent], shotSrc(s))}</div>`;
    case 'warn': return warnHtml(e.text, ' data-ev="' + s.events.lastIndexOf(e) + '"' + (e.open ? ' open' : ''));
    case 'thought': return `<details class="thought" data-ev="${s.events.lastIndexOf(e)}"${e.open ? ' open' : ''}><summary>Thinking</summary><p>${esc(e.text)}</p></details>`;
    case 'tool': return `<details class="tool" data-ev="${s.events.lastIndexOf(e)}"${(e.open ?? e.status === 'in_progress') ? ' open' : ''}><summary><span class="chev">${svg.chev}</span><span data-slot="badge" data-variant="${e.status === 'completed' ? 'ok' : e.status === 'failed' ? 'bad' : 'primary'}">${esc(e.status.replace('_',' '))}</span>${e.exit ? `<span data-slot="badge" data-variant="bad" data-exit>${esc(e.exit)}</span>` : ''}<span class="ttl truncate">${esc(e.title)}</span></summary>${e.diff ? diff(e.diff) : ''}${e.output ? `<pre>${esc(e.output)}</pre>` : e.status === 'in_progress' ? '<pre class="caret"></pre>' : ''}</details>${e.plan ? `<button ${OL} class="open-plan" data-open-plan="${s.events.lastIndexOf(e)}">Open plan</button>` : ''}${agentImgs(e.images, outer.names[s.agent], shotSrc(s))}`;
    case 'notice': return `<div class="notice">${esc(e.text)}${e.restart && window.p9?.restartService ? ' <button ' + OL + ' data-restart-p9>Restart P9</button>' : ''}</div>`;
    case 'error': return `<div class="notice" style="color:var(--destructive)">${esc(e.text)}${/ is not signed in on this computer\./.test(e.text) && window.p9?.agentLogin ? ' <button ' + OL + ' data-signin>Sign in</button>' : ''}</div>`;
  }
  return '';
}
const diff = rows => `<div class="diff">${rows.map(([k, l]) => `<div class="${esc(k)}">${k === 'file' || k === 'hunk' ? '' : (k === 'add' ? '+' : k === 'del' ? '−' : ' ') + ' '}${esc(l)}</div>`).join('')}</div>`;
// A7 Delegate: a worker's open approval or question is drawn in the chat that started it too (and in that chat's own
// parent), under the worker's title. It is the worker's own request, never a copy: answering here answers it there.
const kin = (id, seen = new Set()) => outer.S.sessions.filter(k => k.parent === id && k.id !== id && !seen.has(k.id)).flatMap(k => (seen.add(k.id), [k, ...kin(k.id, seen)]));
const pending = s => ask(s, true) + (s.live ? kin(s.id).filter(k => k.live && k.pending && k.state === 'running').map(k => ask(k, false)).join('') : '');
function ask(s, own) {
  const sub = own ? '' : `<p class="hint" data-ask-from>Asked by the worker “${esc(s.title)}”. Your answer goes to it.</p>`, tag = ` data-ask="${esc(s.id)}"${own ? '' : ' data-ask-sub'}`;
  if (s.pending === 'approval') { const a = s.events.find(e => e.t === 'approval'); if (!a) return ''; return `<div class="pending fx-halo" role="group" aria-label="Approval"${tag}><div class="eyebrow">${own ? 'Approval needed' : 'Worker needs approval'}</div><h4>${esc(a.title)}</h4>${sub}${diff(a.diff)}${a.plan && own ? `<button ${OL} data-open-plan="${s.events.indexOf(a)}">Open plan</button>` : ''}${s.live && own ? '<p class="hint">Sending a message declines this and sends the message instead.</p>' : ''}<div class="acts">${a.options.map(([k, l, kind]) => `<button data-slot="button" data-variant="${(kind || k).startsWith('reject') ? 'outline' : 'default'}" data-size="sm" class="fx-lift" data-approve="${esc(k)}">${esc(l)}</button>`).join('')}</div></div>`; }
  if (s.pending === 'question') { const q = s.events.find(e => e.t === 'question'); if (!q) return ''; return `<form class="pending fx-halo" data-question${tag}><div class="eyebrow">${own ? esc(outer.names[s.agent]) + ' asks' : 'Worker asks'}</div><h4>${esc(q.title)}</h4>${sub}${q.unsupported ? '<p class="hint">P9 cannot show this form faithfully. Decline, or answer in a message.</p>' : ''}${s.live && own ? '<p class="hint">Sending a message declines this question and sends the message instead.</p>' : ''}${q.fields.map((f, i) => { const head = `<span>${esc(f.label)}${f.required ? ' *' : ''}</span>${f.hint ? `<small>${esc(f.hint)}</small>` : ''}`; return f.kind === 'radio' ? `<div class="field">${head}${f.options.map(outer.opt).map(([v, l]) => `<label><input type="radio" name="f${i}" value="${esc(v)}" ${(q.vals?.['f' + i] ?? ('def' in f ? f.def : outer.opt(f.options[0])[0])) === v ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>`
    : f.kind === 'multi' ? `<div class="field">${head}${f.options.map(outer.opt).map(([v, l], j) => `<label><input type="checkbox" name="f${i}~${j}" value="${esc(v)}" ${q.vals?.[`f${i}~${j}`] !== undefined ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>` : `<div class="field">${head}<input data-slot="input" name="f${i}" value="${esc(q.vals?.['f' + i] || '')}"></div>`; }).join('')}<div class="acts">${q.unsupported ? '' : '<button data-slot="button" data-variant="default" data-size="sm" type="submit">Submit answer</button>'}<button ${OL} type="button" data-decline>Decline</button></div></form>`; }
  return '';
}
// E1/I2/F3 (P9-Sprint): the card at the top right of a chat that has workers, its sprint row only. It draws what the session list
// reports (task, ready, verdict, idleSince, parent, state) and the workers' open requests (kin, above); it keeps no state of its own
// but whether it is folded.
// ponytail: folded per chat for this window only (a Set), and a chat opens folded where the card would cover the text (narrow window, Split).
const SPRINT = { folded: new Map() };
const sprintFields = (s, c) => Object.assign(s, { task: c.task ?? null, ready: c.ready ?? null, verdict: c.verdict ?? null, idleSince: c.idleSince ?? null, work: c.queue ?? null, paused: !!c.paused, sprintClosed: !!c.sprintClosed }, c.named && { named: true, title: c.title }); // O172: a name that stays (the user's, or a sprint chat's role) also on a chat started while the window is open. The contract's optional fields: a chat without them looks as it does today. work: the daemon's work queue {done, total, items} (its queue; s.queue here is the composer's)
// Row 722 (the work queue): a worker holding a role works its role's plan items in order, so its row says Work Queue and
// names the first item not yet passed, even over an open_chat task (nightly 11: a start task hid the queue's item).
// Its text is the plan line as planItems reads it, id included ("O7: do thing. Role w"), so the id is not added again.
const itemLine = k => { const q = k.work?.items; if (!q?.length) return k.task?.item || 'No item set';
  const next = q.find(i => i.state !== 'passed'); return 'Work Queue · ' + (next ? next.text || next.id || 'next item' : 'all ' + q.length + ' passed'); };
const SP_LABEL = { paused: 'Paused', working: 'Working', idle: 'Idle', asked: 'Asked', ready: 'Ready', passed: 'Passed', fix: 'Fix', stopped: 'Stopped' };
// A verdict belongs to one exact commit (spec C): one for an older commit than the one reported ready is not a pass of this version.
const verdictOf = k => k.verdict?.commit && k.ready?.commit && k.verdict.commit === k.ready.commit ? k.verdict : null; // no ready commit, or no commit on the verdict: nothing is verified
function workerStatus(k) {
  const v = verdictOf(k);
  if (k.pending && k.state === 'running') return ['asked', null];
  if (k.paused && k.state !== 'stopped') return ['paused', null]; // S13: a paused sprint's worker; a running turn still finishes
  if (v) return [v.result === 'pass' ? 'passed' : 'fix', v.at ?? null];
  if (k.ready) return ['ready', k.ready.at ?? null];
  if (k.state === 'stopped' || k.state === 'stopping') return ['stopped', null];
  if (k.idleSince) return ['idle', k.idleSince];
  return [k.state === 'running' ? 'working' : 'idle', null];
}
// 712: what the card can clear, one rule for the row x, the count and Clear all: a stopped chat, whatever its report or verdict says (a stopping one is still in flight).
const clearable = k => k.state === 'stopped';
// window-3: a worker report ('ready-' + worker id) whose worker is archived is not pinned, wherever it was archived.
const shelved = id => outer.S.sessions.some(k => k.archived && 'ready-' + k.id === id);
const since = at => at ? `<time data-since="${at}">${ageOf(at)}</time>` : '';
const ring = (status, done, total) => { const R = 10, C = +(2 * Math.PI * R).toFixed(2), f = total ? done / total : 0;
  return `<span class="sp-ring" data-status="${status}" role="img" aria-label="${done} of ${total} items merged"><svg viewBox="0 0 28 28" aria-hidden="true"><circle class="t" cx="14" cy="14" r="${R}"/><circle class="a" cx="14" cy="14" r="${R}" stroke-dasharray="${+(C * f).toFixed(2)} ${C}"/></svg><b>${done}/${total}</b></span>`; };
// A worker's own open request, with when it came (the event's time; F3: how long it has waited).
const askOf = k => { const e = k.events.find(x => x.t === k.pending); return e && { k, e, kind: k.pending, at: e.at ?? null }; };
function sprintCard(s) {
  if (s.stub) return '';
  // 712: an archived worker leaves the card, as it leaves the sidebar (listedChats). kin() kept it, so archive_chat changed nothing here.
  const workers = kin(s.id).filter(k => !k.archived);
  // O235 (Reviewer fix 1): a closed sprint's lead still listed with no worker left (its own archive failed, or the workers went
  // another way) keeps a card with Clear, so the lead can still be cleared from here; any other chat without workers has none.
  if (!workers.length) return s.sprintClosed && !s.archived ? `<aside class="sprint" data-sprint data-folded="false" data-auto="false" data-open-asks="0" aria-label="Sprint">
    <div class="sp-headbar"><span class="sp-head"><span class="eyebrow">Sprint</span><span class="sp-sum">Closed · no workers left</span></span></div>
    <div class="sp-body"><button type="button" class="sp-files sp-clearall" data-sprint-clear="*" title="Archive this lead chat: the sprint is closed">Clear this chat</button></div></aside>` : '';
  const project = projectOf(s, (outer.S.projects || []).filter(p => !p.archived));
  const choice = SPRINT.folded.get(s.id), folded = choice ?? false, now = Date.now(); // unchosen: placeSprints opens or folds it by the room this pane has
  const rows = workers.map(k => { const [st, at] = workerStatus(k), items = k.work?.total ?? (k.task?.item ? 1 : 0), passed = k.work ? k.work.done : st === 'passed' ? 1 : 0; // 709: a queue worker's ring is its plan items, done as P9's review record counts them
    return { k, st, at, html: `<li><button type="button" class="sp-row" data-status="${st}" data-sprint-open="${esc(k.id)}" title="Open ${esc(k.title)}">${ring(st, passed, items || 1)}<span class="sp-main"><span class="sp-name">${agentDot(k.agent)}<b class="truncate">${esc(k.title)}</b></span><span class="sp-item truncate"${k.work?.items?.length ? ' data-work-queue' : ''}>${esc(itemLine(k))}</span></span><span class="sp-st"><span class="sp-label">${SP_LABEL[st]}</span>${since(at)}</span></button>${clearable(k) ? `<button type="button" class="sp-clear" data-sprint-clear="${esc(k.id)}" title="Clear from the card (archives the chat)" aria-label="Clear ${esc(k.title)}">×</button>` : ''}</li>` }; });
  const asks = workers.filter(k => k.pending && k.state === 'running').map(askOf).filter(Boolean).sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  const count = st => rows.filter(r => r.st === st).length, bits = [workers.length + (workers.length === 1 ? ' worker' : ' workers'), asks.length && asks.length + ' need you', count('ready') && count('ready') + ' ready'].filter(Boolean);
  return `<aside class="sprint" data-sprint data-folded="${folded}" data-auto="${choice === undefined}" data-open-asks="${asks.length}" aria-label="Sprint">
    <div class="sp-headbar"><button type="button" class="sp-head" data-sprint-fold aria-expanded="${!folded}"><span class="eyebrow">Sprint</span><span class="sp-sum">${bits.join(' · ')}</span>${svg.chev}</button><button type="button" class="sp-files" data-sprint-files ${project ? 'title="Open sprint files"' : 'disabled title="This chat has no project"'}>Files</button></div>
    <div class="sp-body"><ul class="sp-rows">${rows.map(r => r.html).join('')}</ul>${workers.filter(clearable).length > (s.sprintClosed ? 0 : 1) ? `<button type="button" class="sp-files sp-clearall" data-sprint-clear="*" title="Archive every stopped worker${s.sprintClosed ? ', then this lead chat: the sprint is closed' : ''}">Clear ${workers.filter(clearable).length} stopped${s.sprintClosed ? ' and this chat' : ''}</button>` : ''}
    ${asks.length ? `<div class="sp-asks"><h5 class="eyebrow">Waiting on you</h5><ul>${asks.map(a => `<li><button type="button" data-sprint-ask="${esc(a.k.id)}"><span class="sp-akind" data-blocking="${a.kind === 'approval'}">${a.kind === 'approval' ? 'Approval' : 'Question'}</span><span class="sp-atxt truncate">${esc(a.k.title)}: ${esc(a.e.title)}</span>${a.at ? `<span class="sp-wait">waited ${since(a.at)}</span>` : ''}</button></li>`).join('')}</ul></div>` : ''}</div>
  </aside>`;
}
const sprintDoor = () => { if (!window.__sprint && outer.sampleView) window.__sprint = { add: (...x) => { outer.S.sessions.push(...x); renderChats(); }, set: (id, patch) => { Object.assign(sess(id), patch); renderChats(); }, render: () => renderChats() }; }; // ponytail: the UI test's door (sample data is handed in only by tests)
// Per pane: the card moves left of the cards stack only where they overlap this pane, takes the width the pane has, and (unless
// the person chose) opens only when it does not cover the centered text column.
let spObs; // made on first use: the controller's observe() is not there yet when this module loads
function placeSprints() {
  spObs ||= outer.observe(() => placeSprints());
  const cards = outer.$('#cards'), cr = cards?.querySelector('.card') && getComputedStyle(cards).visibility !== 'hidden' ? cards.getBoundingClientRect() : null;
  if (cards) spObs.observe(cards);
  for (const p of document.querySelectorAll('.pane')) {
    const sp = p.querySelector(':scope > .sprint'); if (!sp) continue;
    spObs.observe(p);
    const pr = p.getBoundingClientRect(), over = cr && cr.left < pr.right && cr.right > pr.left;
    let right = over ? Math.round(pr.right - cr.left + 10) : 18, top = 46;
    // Where the cards leave this pane under 220 px beside them (a 720 px Split, an uneven one), the card goes below the stack instead.
    if (over && pr.width - right - 10 < 220) { right = 18; top = Math.max(46, Math.round(cr.bottom - pr.top + 10)); }
    const w = Math.max(120, Math.min(296, Math.floor(pr.width - right - 10)));
    sp.style.setProperty('--sp-top', top + 'px'); sp.style.setProperty('--sp-room', Math.max(120, Math.floor(pr.height - top - 10)) + 'px');
    sp.style.setProperty('--sp-right', right + 'px'); sp.style.setProperty('--sp-w', w + 'px');
    if (sp.dataset.auto === 'true') {
      const colWidth = Math.min(760, pr.width - 40), colLeft = (pr.width - colWidth) / 2, colRight = (pr.width + colWidth) / 2;
      sp.dataset.folded = String(pr.width - right - w < colRight && pr.width - right > colLeft);
    }
    const open = sp.dataset.folded === 'false';
    sp.querySelector('[data-sprint-fold]')?.setAttribute('aria-expanded', String(open));
  }
}
// The live fields (task, ready, verdict, idleSince, work) come from the daemon's list; c2's sprint-state event will carry them too (follows #92).
// Until then a batch of events marks the list stale and it is read again, a field the list no longer has cleared.
const sprintSync = conversations => { const was = JSON.stringify(outer.S.sessions.map(s => [s.id, s.title, s.task, s.ready, s.verdict, s.idleSince, s.work, s.parent, s.sprintClosed]));
  for (const c of conversations) { const s = sess(c.id); if (s) { sprintFields(s, c); s.parent = c.parent ?? s.parent ?? null; } }
  return was !== JSON.stringify(outer.S.sessions.map(s => [s.id, s.title, s.task, s.ready, s.verdict, s.idleSince, s.work, s.parent, s.sprintClosed])); };
setInterval(() => { if (!document.hidden) document.querySelectorAll('time[data-since]').forEach(t => { const x = ageOf(+t.dataset.since); if (t.textContent !== x) t.textContent = x; }); }, 15000);
// A turn is in flight while a tool runs or a reply streams; messages and mode changes queue behind it.
const busy = s => s.live ? s.state === 'running' && !s.pending && !!s.working : s.state === 'running' && !s.pending && (!!s.streaming || s.events.some(e => e.t === 'tool' && e.status === 'in_progress'));
// Only a chat's latest TAIL steps are drawn (the window lagged and froze; one redraw of a 25,000-event
// chat built 31 MB of HTML in about 170 ms, and live chats redraw on every batch). "Show earlier" adds TAIL more.
const TAIL = 200;
function shown(s) {
  const list = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'), from = Math.max(0, list.length - (s.tail || TAIL));
  return (from || s.more !== undefined ? `<button ${GH} class="earlier" data-earlier>Show earlier${from ? ` (${from.toLocaleString()} more)` : ''}</button>` : '')
    + list.slice(from).map(e => event(e, s).replace(/^<([a-z]+)/, `<$1 data-at="${s.events.indexOf(e)}"`)).join(''); // O127: paint() keeps the reader's block by this
}
/* ---------- the message bar's pills (0.1.8): Mode, Model and Effort, one menu kept outside the panes ----------
   Panes are rebuilt from S on every change (every 18 ms while a reply streams); morph keeps each pill button by position and
   only its attributes change, and the menu is never part of a pane, so it stays open with its focus while a chat streams,
   and refreshPill brings its checked item up to date. Each pill is a button with aria-haspopup; the menu is role=menu with
   menuitemradio choices; Escape closes it and focuses its pill; arrows move; Enter picks. The Model menu lists the agent's
   models directly, then Fast mode under its own heading (no "More" submenu). Live chats list the agent's
   own models; the sample data keeps its two names. */
// O47: a chat whose own report is older than the agent's kept list (a chat not run since) offers the kept list, so a
// model the agent dropped is gone from its menu; its own model stays its current one (goneModel says so in the menu).
// O48: a chat on a provider profile has the one model it was started on, whatever the agent or the kept list says.
const profileModels = s => ({ current: s.profile.model, options: ((!started(s) && outer.profiles.find(p => p.id === s.profile.id)?.models) || [s.profile.model]).map(value => ({ value, name: value })) });
const liveModels = s => { if (s.profile) return profileModels(s); const kept = outer.lastModels[s.agent], own = s.models; return own && kept && (s.modelsAt || 0) < (outer.listsAt[s.agent] || 0) ? { current: own.current, options: kept.options } : own || kept || null; };
const goneModel = s => { const m = s.live && liveModels(s), v = s.modelPick || m?.current; return m && v && !m.options.some(o => o.value === v) ? s.model || v : ''; };
const dflt = (s, id, o) => o.name + (s.live && !s.profile && !/default/i.test(o.name) && outer.isDefault(s.agent, id, o.value) ? ' (Default)' : ''); // MC-16; an option the agent itself names its default is left as it is
const modelList = s => s.live ? liveModels(s) : { current: s.model, options: [s.model, s.agent === 'codex' ? 'gpt-5.1-codex-mini' : 'Sonnet 5.5'].map(v => ({ value: v, name: v })) };
// O133: once the chat has reported its own config, the pills name what it runs; a pick it has not taken yet is pending.
const optName = (s, list, id, v) => { const o = list?.find(o => o.value === v); return o ? dflt(s, id, o) : ''; };
const modelName = s => optName(s, modelList(s)?.options, null, s.live && s.models ? s.models.current : s.modelPick || modelList(s)?.current) || s.model;
const modelNext = s => s.live && s.models && s.modelPick && s.modelPick !== s.models.current ? optName(s, modelList(s)?.options, null, s.modelPick) || s.modelPick : '';
// The sample data, and a live chat before its config, keep Effort as a local choice.
const pickers = s => s.live && (s.pickers || outer.lastPickers[s.agent]) || [];
const pickerOf = (s, kind) => pickers(s).find(p => outer.pickerKind(p) === kind);
const pickVal = (s, p) => s.pick?.[p.id] ?? p.current;
const setPick = (s, p, v) => { s.pick ||= {}; if (v === p.current) delete s.pick[p.id]; else s.pick[p.id] = v; };
const effortList = s => pickerOf(s, 'effort')?.options || [...new Set([s.effort, 'High', 'Low'])].map(v => ({ value: v, name: v }));
const effortName = s => { const p = pickerOf(s, 'effort'); if (!p) return s.effort; const v = s.pickers ? p.current : pickVal(s, p); return optName(s, p.options, p.id, v) || v; };
const effortNext = s => { const p = s.pickers && pickerOf(s, 'effort'), v = p && s.pick?.[p.id]; return v ? optName(s, p.options, p.id, v) || v : ''; };
const planOpt = p => p.options.find(o => /plan/i.test(o.value)) || p.options.find(o => /plan/i.test(o.name));
const planOn = s => { const p = pickerOf(s, 'collab'); return !!p && pickVal(s, p) === planOpt(p)?.value; };
// The Mode menu's order per agent. Codex's Plan is its plan collaboration mode on top of the sandbox mode picked before
// (s.mode stays that mode; choosing any other mode turns plan off); Claude's is its own plan mode.
// The menu's order for the two built in; another catalog agent lists its modes in the catalog's order (helpers modes).
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
const pill = (s, kind, label, extra = '', pre = '', next = '') => { const said = label + (next ? `, ${next} pending` : '');
  return `<button type="button" class="pill" data-pill="${kind}" aria-haspopup="menu" aria-expanded="${PM.sid === s.id && PM.kind === kind}" aria-label="${kind}: ${esc(said)}" title="${kind}: ${esc(said)}">${pre}<span class="truncate">${esc(label)}</span>${extra}${next ? `<span class="mode-q pick-q" title="Picked: goes with the next message, shown here once ${esc(outer.names[s.agent])} takes it">→ ${esc(next)}</span>` : ''}</button>`; };
const agentDot = a => `<span class="dot" data-agent="${esc(a)}"></span>`;
const pills = s => pill(s, 'Agent', s.profile?.name || outer.names[s.agent], '', s.profile ? agentDot('profile') : agentDot(s.agent)) + pill(s, 'Mode', modeShown(s), s.modeNext ? '<span class="mode-q" title="Applies when this turn ends">queued</span>' : '') + pill(s, 'Model', modelName(s), '', '', modelNext(s)) + pill(s, 'Effort', effortName(s), '', '', effortNext(s));
document.body.insertAdjacentHTML('beforeend', '<div class="pop" id="pillMenu" role="menu" hidden></div>');
const pmRoot = () => document.getElementById('pillMenu'); // not outer.$: installChat runs before controller.mjs defines $
const mi = (label, checked, data, disabled) => `<button type="button" class="item" role="menuitemradio" aria-checked="${checked}" ${data}${disabled ? ` aria-disabled="true" title="${esc(disabled)}"` : ''}><span class="truncate">${esc(label)}</span></button>`;
const radio = (list, now, data, s, id) => list.map(o => mi(s ? dflt(s, id, o) : o.name, o.value === now, `${data} data-val="${esc(o.value)}"`)).join('');
// O47: what the Model menu says while this daemon run's fresh read is on, or after it failed (signed out, offline).
const listNote = s => { const st = s.live && outer.listState[s.agent], n = outer.names[s.agent], has = modelList(s)?.options.length;
  return st === 'loading' ? `Reading ${n}'s models…` : st === 'failed' ? (has ? `Could not read ${n}'s models just now. This is the last list it reported.` : `Could not read ${n}'s models. Is ${n} signed in?`) : ''; };
// O29: the Agent pill. Each row says what a chat on that agent runs with: this chat's own, or the
// other agent's start (its saved mode, and the Default model and effort from Settings when it still offers them).
// O136: a profile chat's agent is claude, but its mode, model and effort are the profile's, so its Claude row shows Claude's start.
// A chat with messages keeps its agent (its session is that agent's): the other row is shown, disabled, and says why.
const started = s => !!(s.sent || s.session || s.queue?.length || s.events.some(e => e.t === 'user'));
const STAYS = 'This chat has messages, so it stays on its agent. New chat (+) starts one on the other.';
const startsOn = a => { const m = outer.defaultModel(a), e = outer.defaultEffort(a), p = outer.lastPickers[a]?.find(x => outer.pickerKind(x) === 'effort');
  return [outer.startMode(a), outer.lastModels[a]?.options.find(o => o.value === m)?.name || 'Default model', p?.options.find(o => o.value === e)?.name].filter(Boolean); };
const agentMenu = s => '<div class="hd eyebrow">Agent</div>' + Object.keys(modes).map(a => mi(outer.names[a], a === s.agent && !s.profile, `data-agent="${esc(a)}"`, (a !== s.agent || s.profile) && started(s) && STAYS)
  .replace('<span class="truncate">', '<span class="truncate">' + agentDot(a)).replace(/<\/button>$/, `<span class="muted">${esc((a === s.agent && !s.profile ? [modeShown(s), modelName(s), effortName(s)] : startsOn(a)).join(' · '))}</span></button>`)).join('')
  + outer.profiles.map(p => mi(p.name || 'Claude 3rd party', s.profile?.id === p.id, `data-profile="${esc(p.id)}"`, started(s) && s.profile?.id !== p.id && STAYS).replace('<span class="truncate">', '<span class="truncate">' + agentDot('profile')).replace('</span></button>', ' <small class="muted">runs on Claude</small></span><span class="muted">' + esc([outer.startMode('claude'), p.models[0], outer.defaultEffort('claude')].filter(Boolean).join(' · ')) + '</span></button>')).join('')
  + (started(s) ? `<p class="pm-note muted">${STAYS}</p>` : '');
function pillMenuHtml(s, kind) {
  if (kind === 'Agent') return agentMenu(s);
  if (kind === 'Mode') { const now = modeShown(s), noPlan = s.live && s.agent === 'codex' && !pickerOf(s, 'collab') && 'Codex has not offered its plan mode in this chat yet'; return '<div class="hd eyebrow">Mode</div>' + (MODE_ORDER[s.agent] ?? modes[s.agent]).map(m => mi(m, m === now, `data-mode="${esc(m)}"`, m === 'Plan' && noPlan)).join(''); }
  if (kind === 'Effort') { const p = pickerOf(s, 'effort'); return '<div class="hd eyebrow">Effort</div>' + radio(effortList(s), p ? pickVal(s, p) : s.effort, `data-pick="${esc(p?.id ?? '')}"`, p && s, p?.id); }
  const m = modelList(s);
  if (s.profile) return `<div class="hd eyebrow">${esc(s.profile.name)}</div>` + radio(m.options, m.current, 'data-model') + `<p class="pm-note muted" data-list-note>${s.profile.gone ? 'This profile was removed in Settings, so this chat can be read but not continued.' : started(s) ? 'This chat runs on this model only. Start a new chat for another one.' : 'Choose a model before the first message.'}</p>`;
  const gone = goneModel(s), note = [gone && `This chat was on ${gone}, which ${outer.names[s.agent]} no longer lists. Pick one of these.`, listNote(s)].filter(Boolean);
  return `<div class="hd eyebrow">${esc(outer.names[s.agent])}</div>` + radio(m?.options || [], s.modelPick || m?.current, 'data-model', s, null)
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
const itemKey = el => [...el.attributes].filter(a => a.name.startsWith('data-')).map(a => a.name + '=' + a.value).join(' ');
function refreshPill() {
  if (!PM.sid) return;
  const s = sess(PM.sid), btn = s && pillBtn();
  if (!btn) return closePill(false);
  PM.btn = btn;
  const html = pillMenuHtml(s, PM.kind); if (html === PM.html) return;
  // O74: morph keeps rows by position, so a row coming or going above the focused one moved focus onto another value (a list
  // read ending under an open Model menu drops its "Reading…" note; Enter then picked the row below). Focus follows the
  // value: the row with the same data-* attributes, or, when that value is gone, the row now at its position (the nearest).
  const items = pmItems(), at = items.indexOf(document.activeElement), key = at >= 0 && itemKey(items[at]);
  const retainFocus = document.activeElement === btn || pmRoot().contains(document.activeElement);
  PM.html = html; outer.morph(pmRoot(), html);
  const now = pmItems();
  if (key) (now.find(i => itemKey(i) === key) || now[Math.min(at, now.length - 1)])?.focus();
  else if (retainFocus && !pmRoot().contains(document.activeElement)) (pmRoot().querySelector('[aria-checked="true"]') || now[0])?.focus();
}
// note 7: a mode picked mid-turn shows at once (queued) but applies when the turn ends (turnEnd). The loosened modes ask first
// (looseOk, red); the last pick is kept per agent for new chats (startMode), Codex's Plan is not a sandbox mode so it is not.
async function pickMode(s, m) {
  if (LOOSE[m] && !localStorage.getItem('p9-mode-ok:' + m) && !await outer.looseOk(s.agent, m)) return;
  if (modes[s.agent].includes(m)) localStorage.setItem('p9-mode:' + s.agent, m);
  applyMode(s, m); renderChats();
}
// A mode for one chat, from its pill or from Unrestricted (MC-4): mid-turn it is queued for the turn's end; Codex's Plan goes off.
function applyMode(s, m) { if (busy(s)) s.modeNext = m === modeNow(s) ? null : m; else { setMode(s, m); s.modeNext = null; } }
// O29: an empty chat changes agent by being made again on the other one, in the same folder or project, with that agent's
// defaults (startDefaults, startMode). Review (2026-11-09): what was typed and attached comes over, and the new chat takes the
// old one's place: its pane in Split, the chat beside the editor in Dev Focus (SWAP, swapIn; the layout as it was at the pick).
// The old one is deleted only if the daemon finds it was never sent to (empty, threat model row O29); else the new one goes
// the same way and the old one stays as it was, and the bar says why.
const SWAP = new Map(); // the new chat's id -> { from, open, side, done }
function swapIn(id) {
  const w = SWAP.get(id), n = sess(id);
  if (!w || !w.done || !n) return !!w; // under way: its 'created' does not show it; this does, once the old one is gone
  SWAP.delete(id);
  Object.assign(n, { draft: w.from.draft, images: w.from.images, ...(w.folderChange ? { mode: w.from.mode, modelPick: w.from.modelPick, pick: w.from.pick } : {}) });
  outer.S.open = w.open.map(x => x === w.from.id ? id : x).filter(x => outer.S.sessions.some(o => o.id === x));
  if (w.side === w.from.id) outer.S.sideId = id;
  if (outer.S.modal?.kind === 'chat' && outer.S.modal.id === w.from.id) outer.S.modal.id = id; // opened from the panel in another focus
  outer.renderTabs(); renderChats();
  [...document.querySelectorAll(`.pane[data-id="${CSS.escape(id)}"] [data-pill="Agent"]`)].find(b => b.offsetParent)?.focus(); // the one on screen: a pane, or beside the editor
  return true;
}
async function pickAgent(s, a) {
  if ((a === s.agent && !s.profile) || started(s)) return;
  if (!s.live) { outer.usedAgent(a); Object.assign(s, { agent: a, mode: outer.startMode(a), title: `${outer.names[a]} ${outer.S.sessions.filter(x => x.agent === a).length + 1}` }); outer.renderTabs(); return renderChats(); }
  return replaceEmpty(s, a, s.project ? '' : s.folder, s.project);
}
async function replaceEmpty(s, agent, folder, project = null, profile = null, model = '') {
  const w = { from: s, open: [...outer.S.open], side: outer.S.sideId, done: false, folderChange: agent === s.agent && (profile?.id ?? null) === (s.profile?.id ?? null) };
  const r = await outer.liveChat.create(agent, folder, project, model || profile?.model || '', profile?.id || '');
  if (r.status !== 201) return;
  const id = r.body.conversation; SWAP.set(id, w);
  const d = await outer.liveChat.call('deleteChat', { id: s.id, empty: true }, { quiet: true });
  if (d.status !== 200) {
    SWAP.delete(id); outer.S.open = w.open.filter(x => outer.S.sessions.some(o => o.id === x)); renderChats();
    outer.liveChat.call('deleteChat', { id, empty: true });
    return outer.toast({ kind: 'chat', txt: d.body?.error === 'not-empty' ? 'This chat has a message now, so it stays as it was.' : 'The chat could not be replaced.', level: 'warn' }, true);
  }
  while (adding.has(s.id)) await adding.get(s.id).catch(() => {}); // a paste still being read (and its fallback to text) lands before what was typed and attached comes over
  outer.usedAgent(agent); w.done = true; swapIn(id);
}
async function pickChatFolder(s) {
  if (started(s) || s.project || !s.live) return;
  let picked = await window.p9.pickFolder();
  if (picked?.remote) picked = await pickRemoteFolder();
  if (picked === null) return outer.toast({ kind: 'chat', txt: 'Choose a folder inside the workspace, or turn off both restrictions to choose another folder.', level: 'warn' }, true);
  if (typeof picked === 'string') await replaceEmpty(s, s.agent, picked, null, s.profile);
}
function chatFolder(s) {
  if (!s.live) return s.cwd;
  if (!s.folderAsked) {
    s.folderAsked = true;
    outer.liveChat.call('chatFolder', { id: s.id }, { quiet: true }).then(r => {
      s.cwd = r.status === 200 ? r.body.folder : 'Folder unavailable'; renderChats();
    }).catch(() => { s.cwd = 'Folder unavailable'; renderChats(); });
  }
  return s.cwd;
}

function pillPick(item) {
  const s = sess(PM.sid); if (!s || item.getAttribute('aria-disabled') === 'true') return;
  const v = item.dataset.val;
  if (item.dataset.mode) { closePill(); return pickMode(s, item.dataset.mode); }
  if (item.dataset.agent) { closePill(); return pickAgent(s, item.dataset.agent); }
  if (item.dataset.profile) { const p = outer.profiles.find(x => x.id === item.dataset.profile); closePill(); if (p && !started(s) && p.id !== s.profile?.id) return replaceEmpty(s, 'claude', s.project ? '' : s.folder, s.project, p, p.models[0]); return; }
  if (item.hasAttribute('data-model')) { if (s.profile && !started(s) && v !== s.profile.model) { closePill(); return replaceEmpty(s, s.agent, s.project ? '' : s.folder, s.project, s.profile, v); } if (s.live) s.modelPick = v === s.models?.current ? null : v; else s.model = v; }
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
  const body = s.stub ? '<div class="welcome"><p>Loading this chat…</p></div>' : s.events.length === 0 ?`<div class="welcome"><span class="dot" data-agent="${esc(s.agent)}" data-live></span><h2 class="fx-title">What are we working on?</h2><p>Working directory · ${s.live && !s.project && !started(s) ? `<button class="chat-folder" data-chat-folder title="Click to start this chat in another folder">${esc(chatFolder(s))}</button>` : esc(chatFolder(s))}</p><div class="chips"><span data-slot="badge">${esc(s.model)}</span><span data-slot="badge">${esc(s.mode)}</span></div>${s.live ? '<p data-start-hint>Type your first message below to start.</p>' : `<button data-slot="button" data-variant="secondary" style="margin-top:8px" data-start>Start ${esc(outer.names[s.agent])} chat</button>`}</div>`
    : `<div class="col"><p class="chat-folder-readonly">${esc(chatFolder(s))}</p>${shown(s)}${pending(s)}</div>`;
  return `<section class="pane${i === 0 && outer.S.split ? ' focus' : ''}" data-id="${esc(s.id)}"${outer.hideSteps ? ' data-quiet' : ''}${outer.FX.pull === s.id ? ' data-pulled' : ''} aria-label="${esc(outer.names[s.agent])} chat">
    ${(sprintDoor(), sprintCard(s))}
    <div class="ptool"><span class="dot" data-agent="${esc(s.agent)}" ${s.state === 'running' ? 'data-live' : ''}></span>${bare ? `<span class="name">${esc(outer.names[s.agent])}</span>` : crumb(s)}
      <button ${GH} data-steps aria-pressed="${outer.hideSteps}" title="Shows or hides the agent's tool calls and thinking in this chat">${outer.hideSteps ? 'Show steps' : 'Hide steps'}</button>
      ${s.live ? `<button ${GH} data-phone title="Open this chat on your phone">Phone</button>` : ''}
      ${(n => n && !bare ? `<button ${GH} data-chat-files aria-pressed="${outer.side.current()?.slot === 'chat-files' && CF.sid === s.id}" title="Artifacts and files this chat made" aria-label="Artifacts and files (${n})">${svg.files}<span>${n}</span></button>` : '')(s.stub ? 0 : chatItems(s).length)}
      <span class="state" data-s="${s.pending && s.state === 'running' ? 'needs' : esc(s.state)}">${s.pending && s.state === 'running' ? LABEL.needs : stateLabel}</span>
      ${s.state === 'running' ? `<button ${GH} data-stop>Stop</button>` : s.state === 'stopped' && !s.profile?.gone ? `<button ${OL} data-resume>Resume</button>` : ''}
      ${s.live && s.parent ? `<button ${GH} data-notes aria-pressed="${outer.side.current()?.slot === 'worker-notes' && notesSid === s.id}" title="This worker's notes file, read-only">Notes</button>` : ''}
      ${s.live && s.agent === 'claude' && s.session && !away ? `<button ${GH} data-handoff title="Continue this session in Claude Code Remote Control (claude.ai or the Claude app): stops it here and types the command into a terminal">Hand off</button>` : ''}
      ${s.live && s.session && s.state !== 'moved' && window.p9?.sendToServer && !outer.serverInfo?.host
        ? `<button ${GH} data-send-away ${s.profile ? 'disabled ' : s.leaving ? 'disabled ' : s.state === 'moving' ? '' : busy(s) ? 'disabled ' : ''}title="${s.profile ? 'A chat on a provider profile stays on this computer: its key is not sent to a remote' : s.leaving ? 'Moving this chat to the remote' : s.state === 'moving' ? 'The move did not finish: press to finish it' : busy(s) ? 'Finish or stop the turn first' : 'Move this chat to ' + esc(outer.serverInfo?.last || 'your remote (Settings > Remote Connect)') + ' and carry on there: it stops here, and the remote picks it up where it left off'}">Send to remote</button>` : ''}
      ${bare ? '' : tools()}</div>
    <div class="hist">${body}</div>
    <div class="bottom"><div class="col">${pinned(s, outer.mdOf, SHUT.get(), shelved)}${working || s.sending ? `<div class="working"><span class="glyph" aria-hidden="true">${outer.IND.glyphs[outer.IND.frame % outer.IND.glyphs.length]}</span>${working ? esc(outer.names[s.agent]) + ' is working…' : 'Sending…'}${(e => working && e?.t === 'tool' ? `<span class="step truncate" title="${esc(e.title)}">${esc(e.title)}</span>` : '')(s.events.findLast(e => e.t === 'tool' || e.t === 'user'))}</div>` : ''}${s.goal ? (st => `<div class="goal" data-key="goal" title="Goal: ${esc(s.goal.objective + st)}"><span class="truncate">Goal: ${esc(s.goal.objective)}</span>${st ? `<span class="st">${esc(st)}</span>` : ''}</div>`)(s.goal.status === 'active' ? '' : ' · ' + s.goal.status) : ''}${s.readonly ? '' : meters(s)}
      ${s.queue.length || s.held?.length ? strip(s, since, s.queue.map((q, j) => `<div class="q"><span>Queued: ${esc(q.t)}</span><button title="${loading(s) ? 'Loading this chat…' : 'Interrupt and send this now'}" data-qnow="${j}"${loading(s) ? ' disabled' : ''}>${svg.bolt}</button><button title="Remove from the queue" data-qdel="${j}">${svg.x}</button></div>`).join('')) : ''}
      <div class="composer" data-key="composer"><div class="slash" data-slash hidden></div>${s.images?.length || s.quotes?.length ? `<div class="attach" data-key="attach">${(s.quotes || []).map((q, i) => `<span class="att att-quote" title="${esc(q.text + (q.comment ? '\n\n' + q.comment : ''))}">${(name => `<button class="quote-go" data-quote-go="${i}" aria-label="Show the reply quoted: ${name}"><span class="truncate">${name}</span></button><button class="quote-edit" data-quote-edit="${i}" title="Edit the comment" aria-label="Edit the comment on ${name}">${svg.edit}</button><button data-unquote="${i}" title="Remove" aria-label="Remove the quote ${name}">×</button>`)(q.comment ? esc(q.comment.slice(0, 60)) : `“${esc(q.text.replace(/\s+/g, ' ').trim().slice(0, 40))}”`)}</span>`).join('')}${(s.images || []).map((im, i) => `<span class="att${im.file ? ' att-file' : ''}" title="${esc(im.name)}">${im.file ? `<span class="truncate">${esc(im.name)}</span>` : `<img src="data:${im.mimeType};base64,${im.data}" alt="${esc(im.name)}">`}<button data-unattach="${i}" title="Remove" aria-label="Remove ${esc(im.name)}">×</button></span>`).join('')}</div>` : ''}<textarea placeholder="${s.state === 'moved' ? 'This chat carries on at ' + esc(s.movedTo || 'the remote') + ': open it there (the title-bar badge switches to it)' : s.state === 'moving' || s.leaving ? 'Moving to the remote…' : s.readonly ? 'Resume this conversation to send' : s.state === 'idle' ? 'Start a chat to send' : 'Message ' + outer.names[s.agent] + '…'}" rows="2" ${frozen ? 'disabled' : ''}>\n${esc(s.draft || '')}</textarea><div class="bar"><span class="pills">${pills(s)}</span>${working && !frozen ? chip() : ''}<span class="spacer"></span>${(n => n ? `<button data-slot="button" data-variant="ghost" data-size="sm" class="drafts-btn" data-key="drafts" title="Saved drafts (Ctrl+S in the box saves one)" data-drafts>Drafts ${n}</button>` : '')(draftsN())}<button data-slot="button" data-variant="ghost" data-size="icon-sm" title="Attach files (6 MiB each; 4 images, 4 files)" data-attach>${svg.clip}</button><button data-slot="button" data-size="icon-sm" class="send" ${frozen || loading(s) ? 'disabled ' : ''}title="${loading(s) ? 'Loading this chat…' : working ? 'Steer (Enter). Ctrl click interrupts and sends' : 'Send'}" data-send>${svg.send}</button></div></div></div></div>
  </section>`;
}
// The unseen marks (done, failed) kept over a restart: every place that changes one calls this, or a reload brings back a card already opened.
let unseenKept = false;
outer.keepUnseen = () => { if (unseenKept) try { localStorage.setItem('p9-unseen', JSON.stringify(Object.fromEntries(outer.S.sessions.filter(s => s.failed || s.done).map(s => [s.id, s.failed ? 'failed' : 'done'])))); } catch {} };
// only: the chat ids a daemon batch touched; the other panes shown are left as they are.
// N6-1 (d): each drawn <details> -> [its event, open as drawn]. A click opens it at once but toggle comes a task later, so a
// redraw in between would draw it shut from the event; the redraw first keeps any open state the user changed.
const DRAWN = new WeakMap();
function renderChats(only) {
  const ids = outer.S.split ? outer.S.open.slice(0, 2) : outer.S.open.slice(0, 1);
  const ss = ids.map(id => outer.S.sessions.find(s => s.id === id)).filter(Boolean);
  if (document.hasFocus()) { const seen = [...(outer.S.focus === 'chat' ? ss : []), outer.mdl.open && outer.S.modal?.kind === 'chat' && outer.S.sessions.find(s => s.id === outer.S.modal.id)].filter(s => s?.done || s?.failed); seen.forEach(s => { s.done = s.failed = false; }); if (seen.length) outer.renderCards(); }
  outer.keepUnseen();
  outer.$('#chats').dataset.split = String(outer.S.split && ss.length > 1);
  for (const s of [...ss, outer.mdl.open && outer.S.modal?.kind === 'chat' && sess(outer.S.modal.id)]) if (s?.stub) history(s);
  paint(outer.$('#chats'), ss, only);
  outer.bottoms.disconnect(); outer.$('#chats').querySelectorAll(':scope > .pane > .bottom').forEach(b => outer.bottoms.observe(b));
  if (outer.mdl.open && outer.S.modal?.kind === 'chat') paint(outer.$('#mdlBody'), [outer.S.sessions.find(s => s.id === outer.S.modal.id)].filter(Boolean), only);
  outer.renderSideChat(only);
  refreshPill();
  if (outer.side.current()?.slot === 'artifact' && ART.mode === 'panel' && outer.S.focus === 'chat' && !chatsInView().includes(ART.state?.sid)) outer.side.close('artifact', 'hidden'); // item 19
  outer.side.refresh(); // a pinned artifact shows only while its chat is in view (O28)
  chatFilesFollow(ids);
  placeSprints();
  outer.tickPets(); // paint rebuilt the panes: put their pets back now, not on the next frame
}
// The same pane renders in Chat Focus and inside a chat modal; root says which.
// E2: with only, and the same panes still shown in the same order, just those panes are rebuilt and re-wired. Before,
// each daemon batch rebuilt every pane shown, so a quiet 200-step chat beside a streaming one cost the same each time.
// O127: a reader scrolled up keeps the block they read at the same offset. Restoring scrollTop in pixels moved them
// whenever anything above changed height: the 200-step window sliding by one block per new step, a running tool
// above closing as it finished. The anchor is the first block on screen, kept by its event (not its index, which
// shifts when a step is removed); held() returns where to scroll so it sits where it was, or undefined if it is gone.
// AT: each drawn block's event, bound when it is drawn. By the next paint s.events has already changed, so data-at on
// the old blocks may name another event (one removed or added above it, review #377 FIX1).
const AT = new WeakMap();
const anchorOf = h => { const top = h.getBoundingClientRect().top;
  const el = [...h.querySelectorAll(':scope > .col > [data-at]')].find(c => c.getBoundingClientRect().bottom > top);
  return el && AT.has(el) ? { ev: AT.get(el), off: el.getBoundingClientRect().top - top } : null; };
// O127 rest: more than TAIL new steps arriving while the reader sits up would slide the drawn window past their block, and
// held() would find nothing to hold. The window grows to keep it drawn, and goes back to its size once the reader follows
// the bottom again or never scrolled up (s.grown: the size before it grew). Show earlier while it is grown keeps the larger window: the user asked for it.
// GROW_MAX: the grown window stops at 10 windows (about 2,000 steps), so a reader thousands of steps up in a chat that keeps
// streaming does not redraw all of them on every batch, which is the cost TAIL exists to avoid (#390's weakest part).
const GROW_MAX = TAIL * 10;
const keepIn = (s, v) => {
  if (!s || !v) return;
  if (!v.up) { if (s.grown !== undefined) { s.tail = s.grown || undefined; delete s.grown; } return; }
  const list = v.anchor?.ev && s.events.filter(e => e.t !== 'approval' && e.t !== 'question'), i = list ? list.indexOf(v.anchor.ev) : -1;
  if (i < 0) return; // no anchor (scrolled up inside a card with no step in view, review #404): nothing to keep in
  const want = Math.min(list.length - i, GROW_MAX); // no further: past it the reader falls back to the pixel restore
  if (want > (s.tail || TAIL)) { s.grown ??= s.tail || 0; s.tail = want; }
};
const held = (s, h, a) => { const el = a?.ev && h.querySelector(`:scope > .col > [data-at="${s.events.indexOf(a.ev)}"]`);
  return el ? Math.round(h.scrollTop + el.getBoundingClientRect().top - h.getBoundingClientRect().top - a.off) : undefined; }; // whole px: within 1 px of where it was
// Records where each pane's reader is (outer.view). Run before every paint, and by keepPlace() before the chats hide (O212).
const save = (root, panes) => panes.forEach(p => { const h = p.querySelector('.hist'), ta = p.querySelector('.composer textarea'), k = root.id + ':' + p.dataset.id, was = outer.view[k], pinned = h.scrollHeight - h.scrollTop - h.clientHeight < 24;
  if (!h.getClientRects().length || was?.hid) { if (was && h.getClientRects().length) delete was.hid; return; }
  outer.view[k] = { top: h.scrollTop, pinned, up: !pinned && (!was || was.up || h.scrollTop < (was.at ?? was.top)), selection: [ta.selectionStart, ta.selectionEnd], anchor: anchorOf(h) }; });
// O212 review: a scroll alone paints nothing, so the chats about to hide record where the reader is now; hidden, they cannot.
const keepPlace = () => { const r = document.getElementById('chats'); if (r) save(r, [...r.querySelectorAll(':scope > .pane')]); };
function paint(root, ss, only) {
  const bare = root.id === 'mdlBody', old = [...root.querySelectorAll(':scope > .pane')];
  const part = only && old.length === ss.length && old.every((p, i) => p.dataset.id === ss[i].id);
  // A7: a worker's event repaints the chats above it too (its open request is drawn there).
  const up = id => { const out = []; for (let k = sess(id); k && out.length < 9; k = k.parent && sess(k.parent)) out.push(k.id); return out; };
  const touched = part && new Set([...only].flatMap(up));
  const panes = part ? old.filter(p => only.has(p.dataset.id) || touched.has(p.dataset.id)) : old;
  if (part && !panes.length) return;
  // up: the reader scrolled up themselves. Not at the bottom only because content below them grew (an image loading
  // after the paint, CI #390) is not reading up, so it does not grow the window (keepIn). Compared with where place() left it.
  // O212: a pane under display:none (the Projects and Archived pages hide #chats) has no box: it reads 0 high, so it looked
  // pinned, and place() could not scroll it. Its record stays as it was before it hid (hid), and the first paint after it
  // shows again places it from that record, not from what the hidden paints left on screen.
  save(root, panes);
  panes.forEach(p => keepIn(sess(p.dataset.id), outer.view[root.id + ':' + p.dataset.id]));
  panes.forEach(p => p.querySelectorAll('details[data-ev]').forEach(d => { const w = DRAWN.get(d); if (w?.[0] && d.open !== w[1]) w[0].open = d.open; }));
  const a = document.activeElement, caret = a?.matches('textarea, [data-question] input[data-slot]') && root.contains(a) ? { id: a.closest('.pane').dataset.id, n: a.name, s: a.selectionStart, e: a.selectionEnd } : null;
  if (part) panes.forEach(p => { const i = old.indexOf(p), t = document.createElement('template'); t.innerHTML = pane(ss[i], i, bare); outer.addHalos(t.content); outer.attrs(p, t.content.firstElementChild); outer.sync(p, t.content.firstElementChild); });
  else outer.morph(root, ss.map((s, i) => pane(s, i, bare)).join('<div class="handle-v" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize the two chats (arrow keys)"></div>'));
  const split = root.id === 'chats' && root.querySelector(':scope > .handle-v'); // morph keeps the bar by position; wire it once
  if (split && !outer.wiredBars.has(split)) { outer.wiredBars.add(split); dragBar(split, { axis: 'x', get: () => root.querySelector('.pane').offsetWidth, set: px => root.style.setProperty('--split-l', px + 'px'), min: 280, max: () => root.clientWidth - 281, signal: outer.lifetime.signal }); }
  (part ? panes : root.querySelectorAll('.pane')).forEach(p => {
    const s = sess(p.dataset.id), h = p.querySelector('.hist'), k = root.id + ':' + s.id, first = !outer.view[k];
    const v = outer.view[k] ??= { pinned: true }; // a new pane follows the bottom; its record holds where place() left it (FIX2: up needs that from the first paint)
    const place = () => { if (!h.getClientRects().length) return void (v.hid = true); // O212: hidden, nothing to scroll; placed on the next paint shown
      h.scrollTo({ top: v.pinned ? 1e6 : held(s, h, v.anchor) ?? v.top, behavior: 'instant' }); v.at = h.scrollTop; }; // at: where it was left, for up
    h.querySelectorAll(':scope > .col > [data-at]').forEach(el => AT.set(el, s.events[el.dataset.at]));
    place(); if (first) document.fonts.ready.then(() => requestAnimationFrame(place)); // first paint: late font swap leaves it short of the bottom
    p.querySelectorAll('details[data-ev]').forEach(d => { const e = s.events[d.dataset.ev]; DRAWN.set(d, [e, d.open]); d.ontoggle = () => { if (e) e.open = d.open; DRAWN.set(d, [e, d.open]); }; });
    p.querySelectorAll('img[data-chat-img]:not([src])').forEach(img => loadImg(s, img.dataset.chatImg)); watchShots(s, p);
    // A7: a card answers the chat it came from (data-ask): this one, or a worker of it.
    const asker = el => outer.S.sessions.find(x => x.id === el.closest('[data-ask]')?.dataset.ask) || s;
    p.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => { const s = asker(b); if (s.live) return outer.liveChat.approve(s, b.dataset.approve); const a = s.events.find(e => e.t === 'approval'); s.events = s.events.filter(e => e !== a); s.pending = null; if (b.dataset.approve === 'reject') { s.events.push({t:'notice', text:'Denied: ' + a.title + '. ' + outer.names[s.agent] + ' will take another approach.'}); reply(s, 'Understood, I will not touch server.ts. I can expose the grace through the existing /api/conversations payload instead; say so and I will do that.'); } else { s.events.push({t:'tool', status:'completed', title:a.title, diff:a.diff}); const plan = s.events.find(e => e.t === 'plan'); if (plan) { plan.entries[2][0] = 'completed'; plan.entries[3][0] = 'in_progress'; } reply(s, 'Bootstrap now carries leaseGraceMs. Next I will read it in the chat-pane footer so the 60 s copy stops being hardcoded.'); } answered(s); });
    p.querySelectorAll('[data-question]').forEach(q => { const s = asker(q); q.oninput = e => { const qe = s.events.find(e => e.t === 'question'); qe.vals = Object.fromEntries(new FormData(q)); (qe.touched ??= new Set()).add(e.target.name.split('~')[0]); }; q.onsubmit = e => { e.preventDefault(); if (s.live) return outer.liveChat.answer(s, Object.fromEntries(new FormData(q))); const v = new FormData(q).get('f0'), qe = s.events.find(e => e.t === 'question'); s.events = s.events.filter(e => e.t !== 'question'); s.pending = null; s.events.push({t:'tool', status:'completed', title:qe.title, output:'answer: ' + v}); reply(s, v); answered(s); }; q.querySelector('[data-decline]').onclick = () => { if (s.live) return outer.liveChat.decline(s); s.events = s.events.filter(e => e.t !== 'question'); s.pending = null; s.events.push({t:'notice', text:'Question declined.'}); answered(s); }; });
    const ta = p.querySelector('.composer textarea'); // not the queue's editor (A2 step 3)
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
    ta.oninput = () => { s.draft = ta.value; s.recall = null; showSlash(); }; // any typing ends an up-arrow recall
    if (caret && caret.id === s.id) { const c = caret.n === 'heldEdit' ? p.querySelector('[name=heldEdit]') : caret.n ? p.querySelector(`[data-question] [name="${caret.n}"]`) : ta; if (c) { c.focus(); c.setSelectionRange(caret.s, caret.e); } else ta.focus(); } // CP9: the answered question's field is gone
    // note 8: while a turn runs, Enter queues the message; Ctrl Enter (or Ctrl click) interrupts and sends it now.
    // 2026-10-24: a live chat sends at once, and the daemon puts it into the running turn; it queues only behind messages
    // already queued, or when the daemon refuses it mid-turn (liveChat.prompt).
    // CP1: mid-turn, when says how (composer.mjs): Enter or Steer steers it in after the current step, Tab or Queue sends it after the turn,
    // Ctrl Enter or Interrupt (when 'now') stops the turn and sends it.
    const go = (now, when) => { const typed = ta.value.trim(), cmd = (n => !!n && (s.commands || outer.lastCommands[s.agent] || []).some(c => c.name === n))(/^\/(\S+)/.exec(typed)?.[1]), t = cmd ? typed : quoted(s.quotes, typed); if (adding.has(s.id)) return outer.toast({ kind: 'not sent', txt: 'Still attaching a file. Send again in a moment.', level: 'warn' }, true); if (!canSend(s, t, now)) return; s.draft = ''; s.recall = null; const from = !cmd && s.quotes?.length ? { draft: typed, quotes: s.quotes } : undefined; if (from) s.quotes = []; sendText(s, t, now, when, from); if (bare && outer.settings.closeOnSend) outer.closeModal(); };
    const stopTurn = () => { cancelTurn(s); outer.renderTabs(); renderChats(); };
    ta.onkeydown = e => {
      plainPaste = !e.isComposing && e.shiftKey && (e.ctrlKey || e.metaKey) && e.code === 'KeyV' ? ta : null;
      if ((e.key === 'Tab' || e.key === 'Enter' && ta.value !== '/' + slash.querySelector('[data-cmd]')?.dataset.cmd) && !e.shiftKey && !slash.hidden) { e.preventDefault(); slash.querySelector('[data-cmd]').onmousedown(e); return; }
      // A2 step 2: Up in an empty box, or on a prompt it brought back, gives the one you sent before (caret at its start, so
      // Up again goes further back); Down on a recall goes forward (caret at its end), then empty. Up acts only with the caret
      // at the very start and Down only at the very end, so the caret still moves through a long or wrapped prompt. Typing
      // and sending end a recall, so typed or edited text is never replaced. s.recall is the event itself, so loading earlier
      // history keeps it. Only your own prompts: not another chat's, and not one joined from several senders (each part of
      // a joined prompt starts with its sender's [P9: ...] line, in old history too).
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !(e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) && ta.selectionStart === ta.selectionEnd) {
        const sent = s.events.filter(v => v.t === 'user' && v.text && !v.from && !v.info && !v.ask && !v.text.startsWith('[P9: ')), up = e.key === 'ArrowUp';
        const at = !ta.value ? sent.length : s.recall?.text === ta.value ? sent.indexOf(s.recall) : -1, to = at + (up ? -1 : 1);
        if (at >= 0 && to >= 0 && (up ? ta.selectionStart === 0 : at < sent.length && ta.selectionStart === ta.value.length)) {
          e.preventDefault(); s.recall = sent[to] ?? null; ta.value = s.draft = s.recall?.text ?? ''; const c = up ? 0 : ta.value.length; ta.setSelectionRange(c, c); showSlash(); return;
        }
      }
      // A2 step 7: Ctrl+S saves the box's text as a draft and empties the box; in an empty box it opens the saved drafts.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyS') { e.preventDefault(); return ta.value.trim() || s.quotes?.length ? putAside(s, ta) : draftsOf(s, p); }
      // Tab with an empty box still moves focus on.
      const key = busy(s) && !s.readonly && turnKey(e);
      if (key === 'cancel') { e.preventDefault(); e.stopPropagation(); return stopTurn(); }
      if (key === 'steer' || key === 'queue' && (ta.value.trim() || s.quotes?.length)) { e.preventDefault(); return go(false, key); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(e.ctrlKey || e.metaKey); }
    };
    p.querySelector('[data-send]').onclick = e => go(e.ctrlKey || e.metaKey);
    p.querySelectorAll('[data-when]').forEach(b => b.onclick = () => go(b.dataset.when === 'now', b.dataset.when));
    p.querySelectorAll('[data-cancel]').forEach(b => b.onclick = stopTurn);
    p.querySelectorAll('[data-sprint-fold]').forEach(b => b.onclick = () => { SPRINT.folded.set(s.id, b.getAttribute('aria-expanded') === 'true'); renderChats(); });
    p.querySelectorAll('[data-sprint-files]').forEach(b => b.onclick = () => outer.openProject?.(s.project, s.id));
    // 712: clearing a worker archives its chat (the daemon's archive, so every window and the sidebar agree; Archived view undoes it).
    p.querySelectorAll('[data-sprint-clear]').forEach(b => b.onclick = async () => {
      const ws = b.dataset.sprintClear === '*' ? kin(s.id).filter(k => !k.archived && clearable(k)) : outer.S.sessions.filter(k => k.id === b.dataset.sprintClear);
      // 712: a cleared worker's report closes with it (SHUT, as its own x does); another worker's report stays.
      // O235 (Reviewer fix 1): a refused archive already says why (liveChat.call's toast); a rejected call says so here, and the
      // ones that did go stay cleared, so the redraw below shows where it stopped and Clear can be pressed again.
      const archive = id => outer.liveChat.call('archiveChat', { id, archived: true }).then(r => r.status === 200,
        () => (outer.toast({ kind: 'chat', txt: 'A chat could not be archived. Press Clear again.', level: 'bad' }, true), false));
      for (const k of ws) { if (!(await archive(k.id))) continue; k.archived = true; const c = s.cards?.get('ready-' + k.id); if (c) SHUT.add(reportKey(s, c)); }
      // O235: Close stopped every chat of the sprint, so once no worker is left on the card its lead clears too.
      if (b.dataset.sprintClear === '*' && s.sprintClosed && !kin(s.id).some(k => !k.archived) && await archive(s.id)) s.archived = true;
      outer.renderTabs(); renderChats(); });
    p.querySelectorAll('[data-sprint-open]').forEach(b => b.onclick = () => { show(b.dataset.sprintOpen); outer.renderTabs(); renderChats(); });
    p.querySelectorAll('[data-sprint-ask]').forEach(b => b.onclick = () => p.querySelector(`[data-ask="${CSS.escape(b.dataset.sprintAsk)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    p.querySelectorAll('[data-restart-p9]').forEach(b => b.onclick = () => outer.restartP9(b));
    // PH5: the daemon stops the chat and opens a terminal with the command typed in; the dock shows that terminal.
    p.querySelectorAll('[data-handoff]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      const r = await outer.liveChat.call('handoff', { id: s.id });
      if (!r.body?.terminal) {
        const text = r.body?.command ? 'The terminal did not open. Run this in a terminal in the chat folder to continue: ' + r.body.command : r.body?.message;
        if (text) { s.events.push({ t: 'notice', text }); renderChats(); }
        b.disabled = false; return;
      }
      outer.showTerminal(r.body.terminal);
    });
    // D14: main moves the chat over its own tunnel (desktop/move.mjs); the moving, moved and move-failed events say how it went.
    p.querySelectorAll('[data-send-away]').forEach(b => b.onclick = () => outer.leave(s));
    // D7: "not signed in" opens the setup wizard at its agents step (browser sign-in, or sign-in in a P9 terminal).
    // Item 15: by name (the pick step now comes first), with the chat's own agent on the step even when it was not picked.
    p.querySelectorAll('[data-signin]').forEach(b => b.onclick = () => outer.welcome('agents', s.agent, true));
    p.querySelectorAll('[data-copycode]').forEach(b => b.onclick = () => copy(b.nextElementSibling.textContent, b));
    p.querySelectorAll('[data-artifact]').forEach(b => b.onclick = () => openArtifact({ ...chipArtifact(b), sid: s.id }));
    p.querySelectorAll('[data-open-plan]').forEach(b => b.onclick = () => openPlan(s, b.dataset.openPlan));
    // window-4: the folded report's title and its fit (tuck.mjs); the first open report loads it (pinned.mjs TUCK.want), then draws it.
    TUCK.wire?.(p, s, renderChats); if (TUCK.want) import('./tuck.mjs').then(() => renderChats());
    p.querySelectorAll('[data-unhold]').forEach(b => b.onclick = () => outer.liveChat.call('unhold', { id: s.id, held: b.dataset.unhold, now: 'now' in b.dataset || undefined }));
    p.querySelectorAll('[data-hedit]').forEach(b => b.onclick = () => { const h = s.held.find(x => x.id === b.dataset.hedit); s.hedit = { id: h.id, text: h.text, was: h.text, base: h.text }; renderChats(); const ta = p.querySelector('[name=heldEdit]'); ta?.focus(); ta?.setSelectionRange(1e6, 1e6); });
    // ed.saving: the words sent, the field read-only (Esc too) until their held-text event (editSeen) or the answer settles it.
    p.querySelectorAll('[name=heldEdit]').forEach(ta => { ta.oninput = () => { s.hedit.text = ta.value; };
      ta.onkeydown = e => { if (e.isComposing) return; const ed = s.hedit;
        if (e.key === 'Escape') { e.stopPropagation(); if (ed.saving == null) { s.hedit = null; renderChats(); } return; }
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault(); e.stopPropagation(); if (ed.saving != null) return;
        if (ed.text === ed.was) { s.hedit = null; return renderChats(); }
        ed.saving = ed.text; ed.op = crypto.randomUUID(); ed.lost = null; renderChats(); const base = ed.base;
        outer.liveChat.call('heldText', { op: ed.op, id: s.id, held: ed.id, text: ed.saving, was: ed.was }, { quiet: true }).catch(() => ({})).then(r => { if (s.hedit !== ed) return; const sent = ed.saving; ed.saving = null;
          if (r.status === 200) { s.hedit = null; return renderChats(); }
          // Unsure: no answer, or the retry's 503 or outcome-unknown (liveChat.call): the save may have landed.
          const unsure = !r.status || r.status === 503 || r.body?.error === 'outcome-unknown'; if (unsure) ed.lost = sent;
          // Its message already gone (a catch-up skipped its event, and the load left this to the answer): settled here.
          if (!s.stub && !s.held?.some(h => h.id === ed.id)) editGone(s, false);
          // A newer held-text event that came first already moved base on; the answer's older words do not set it back.
          else if (r.body?.error === 'changed') { if (ed.base === base) ed.base = r.body.text; ed.was = ed.base; s.events.push({ t: 'notice', text: 'Another window changed this queued message to: ' + ed.base + ' Enter saves yours over it; Esc keeps that one.' }); }
          // not-held: it left before the save; its event settles the edit (carry).
          else if (r.body?.error !== 'not-held') s.events.push({ t: 'notice', text: 'Your edit ' + (unsure ? 'got no sure answer (' + (r.body?.error || r.status || 'none') + '), so it may or may not be saved' : r.body?.error === 'daemon-outdated' ? 'was not saved: the P9 service is older than this app and cannot edit a queued message (update it, or take this one back with its x)' : 'was not saved (' + (r.body?.error || r.status) + ')') + '. It is still open.' });
          renderChats(); }); }; });
    // Only the user's click is kept: a <details> drawn open fires toggle too, which would pin a short strip open for good.
    p.querySelectorAll('[data-queue]>summary').forEach(m => m.onclick = () => { s.queueOpen = !m.parentElement.open; });
    p.querySelectorAll('[data-qdel]').forEach(b => b.onclick = () => { s.queue.splice(+b.dataset.qdel, 1); renderChats(); });
    p.querySelectorAll('[data-qnow]').forEach(b => b.onclick = () => { if (loading(s)) return; interrupt(s, s.queue.splice(+b.dataset.qnow, 1)[0].t); });
    // The Mode, Model and Effort pills each open their menu (#pillMenu, outside the panes; the pill menu code above pane).
    p.querySelectorAll('[data-pill]').forEach(b => b.onclick = () => PM.btn === b ? closePill() : openPill(b, s, b.dataset.pill));
    p.querySelector('[data-attach]').onclick = () => pickImages(s);
    const db = p.querySelector('[data-drafts]'); if (db) db.onclick = () => draftsOf(s, p);
    // A pasted screenshot or files dropped anywhere on the chat attach like the paperclip; pasted text pastes as before.
    // A2 step 1: a big paste of text attaches as a file (pastedFiles); Ctrl Shift V pastes it as text.
    // Over a selection it stays text, so it replaces what was selected as any paste does.
    ta.onpaste = e => {
      const files = pastedFiles(e.clipboardData, plainPaste === ta || ta.selectionStart !== ta.selectionEnd); plainPaste = null; if (!files.length) return;
      e.preventDefault(); const text = e.clipboardData.files.length ? '' : e.clipboardData.getData('text/plain'), was = ta.value, at = ta.selectionStart;
      addImages(s, files).then(ok => { // a refused big paste (four files already, or over 6 MiB) goes into the box as text, not lost:
        if (!text) return; if (ok) return outer.toast({ kind: 'pasted', txt: 'A big paste went in as pasted.txt. Ctrl Shift V pastes it as text.', level: 'ok' }, true);
        const now = s.draft ?? ''; // where it was pasted, or after what was typed since
        s.draft = now === was ? was.slice(0, at) + text + was.slice(at) : now + (now ? '\n' : '') + text; s.recall = null; renderChats();
      });
    };
    ta.onkeyup = ta.onblur = () => { plainPaste = null; }; // a Ctrl Shift V that pasted nothing does not keep a later paste as text
    p.ondragover = e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); };
    p.ondrop = e => { const files = [...e.dataTransfer.files]; if (files.length) { e.preventDefault(); addImages(s, files); } };
    p.querySelectorAll('[data-unattach]').forEach(b => b.onclick = () => { s.images.splice(+b.dataset.unattach, 1); renderChats(); });
    // A2 step 6: Quote on a reply quotes all of it; a selection inside one reply quotes that part. Either opens the box.
    p.querySelectorAll('[data-unquote]').forEach(b => b.onclick = () => { s.quotes.splice(+b.dataset.unquote, 1); renderChats(); });
    p.querySelectorAll('[data-quote-reply]').forEach(b => b.onclick = () => { const e = s.events[b.closest('[data-at]')?.dataset.at]; if (e?.text) quote(s, p, b.getBoundingClientRect(), e.text, e.text, src(s, e)); });
    // Follow-up: the chip's pencil opens the box with its comment; the chip itself shows the reply it came from.
    p.querySelectorAll('[data-quote-edit]').forEach(b => b.onclick = () => { const q = s.quotes?.[+b.dataset.quoteEdit]; if (q) quote(s, p, b.getBoundingClientRect(), q.text, q.text, q, q); });
    p.querySelectorAll('[data-quote-go]').forEach(b => b.onclick = () => showSource(s, p, s.quotes?.[+b.dataset.quoteGo]));
    const hist = p.querySelector('.hist');
    if (hist) hist.onpointerup = () => setTimeout(() => { const sel = getSelection(), r = !sel.isCollapsed && sel.rangeCount && sel.getRangeAt(0), at = r && r.commonAncestorContainer, msg = at && (at.nodeType === 1 ? at : at.parentElement).closest('.msg.agent'), raw = msg && hist.contains(msg) && sel.toString(), text = raw && raw.trim(); if (text) commentOn(s, p, hist, r.cloneRange(), text, raw, src(s, s.events[msg.closest('[data-at]')?.dataset.at])); });
    const more = p.querySelector('[data-earlier]'); if (more) more.onclick = async () => {
      if (s.fetching) return;
      const h = p.querySelector('.hist'), below = h.scrollHeight - h.scrollTop;
      if (s.more !== undefined && s.events.filter(e => e.t !== 'approval' && e.t !== 'question').length < (s.tail || TAIL) + TAIL) { s.fetching = true; try { await earlier(s); } finally { s.fetching = false; } }
      s.tail = (s.tail || TAIL) + TAIL; delete s.grown; renderChats(); h.scrollTop = h.scrollHeight - below;
    };
    const folder = p.querySelector('[data-chat-folder]'); if (folder) folder.onclick = () => void pickChatFolder(s);
    const st = p.querySelector('[data-start]'); if (st) st.onclick = () => { s.state = 'running'; s.events.push({t:'notice', text:'Connected over ACP · ' + s.model}); outer.renderTabs(); renderChats(); };
    const stop = p.querySelector('[data-stop]'); if (stop) stop.onclick = () => stopChat(s);
    const res = p.querySelector('[data-resume]'); if (res) res.onclick = () => { if (s.live) return p.querySelector('.composer textarea').focus(); s.state = 'running'; s.readonly = false; s.events.push({t:'notice', text:'Resumed natively (session/resume).'}); outer.renderTabs(); renderChats(); };
    const cf = p.querySelector('[data-chat-files]'); if (cf) cf.onclick = () => outer.side.current()?.slot === 'chat-files' && CF.sid === s.id ? outer.side.close('chat-files') : openChatFiles(s.id);
    p.querySelector('[data-steps]').onclick = () => { outer.hideSteps = !outer.hideSteps; localStorage.setItem('p9-hide-steps', outer.hideSteps ? '1' : '0'); renderChats(); };
    const nt = p.querySelector('[data-notes]'); if (nt) nt.onclick = () => outer.side.current()?.slot === 'worker-notes' && notesSid === s.id ? outer.side.close('worker-notes') : openNotes(s);
    const ph = p.querySelector('[data-phone]'); if (ph) ph.onclick = () => continueOnPhone(s);
  });
}
function answered(s) {
  if (outer.mdl.open && outer.S.modal?.kind === 'chat' && outer.S.modal.id === s.id) outer.closeModal();
  outer.renderTabs(); renderChats(new Set([s.id]));
}
// Paperclip (it only drew a blue square). Threat model row 20; the daemon checks the same limits.
function pickImages(s) {
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true });
  input.onchange = () => addImages(s, input.files);
  input.click();
}
// The paperclip, a pasted screenshot and dropped files all come through here (pasting screenshots did not work).
// attach.mjs loads on the first attach; a failed load says so and changes nothing, and the next attach imports it afresh.
// One attach at a time per chat (paste, paperclip or drop), and no send while one runs: two at once both passed the four-file
// check, and a send took s.images while a file was still being read into it.
const adding = new Map(); // chat id -> its attach now
// A2 step 6: quote.mjs loads on the first quote; a failed load says so, and the next quote imports it afresh.
// The chat a box or menu was asked from: still in this pane (the patcher reuses panes), still shown (focus modes hide with
// visibility), and in the top dialog when one is open (raiseToasts' rule: the last opened still modal). The quote box checks it
// when it loads, while it is open, and on Comment; the drafts menu when it loads and when a draft is taken.
const aliveIn = (s, p) => () => p.isConnected && p.dataset.id === s.id && p.checkVisibility({ visibilityProperty: true }) && (outer.modals.filter(d => d.matches(':modal')).pop()?.contains(p) ?? true);
// from: the reply quoted, { ev, chat } (src): the event itself (loading earlier steps keeps it) and its chat. Never matched by
// its words (review: they found another chat's or reply's), nor by a cursor (a moved chat is renumbered on its new machine).
// was: the chip being edited, replaced in place; without it the quote is added.
const src = (s, ev) => ({ ev, chat: s.id });
const quote = (s, p, rect, text, raw, from, was) => { import('./quote.mjs').then(m => {
  const ta = () => p.querySelector('.composer textarea'), alive = aliveIn(s, p);
  if (alive()) m.quoteBox({ rect, text, raw, comment: was?.comment, edit: !!was, alive, host: p.closest('dialog') || document.body, back: () => ta()?.focus(),
    add: (q, away) => { if (!outer.S.sessions.includes(s)) return; // the chat was deleted meanwhile
      const qs = s.quotes ||= [], i = qs.indexOf(was), n = { ...q, ...(was ? { text: was.text } : {}), ev: from.ev, chat: from.chat }; if (i >= 0) qs[i] = n; else qs.push(n); renderChats(); if (!away) ta()?.focus(); } });
}, () => outer.toast({ kind: 'chat', txt: 'The quote box did not load. Select the text again.', level: 'bad' }, true)); };
// A selection in a reply shows a small Comment button beside it (the selection stays, so Copy works); the button opens the box.
const commentOn = (s, p, view, range, text, raw, from) => import('./quote.mjs').then(m => {
  const alive = aliveIn(s, p);
  if (alive()) m.commentButton({ range, raw, view, alive, host: p.closest('dialog') || document.body, pick: rect => quote(s, p, rect, text, raw, from) });
}, () => {});
// A chip clicked: its reply scrolled to the middle of the chat and marked for a moment, earlier steps drawn first if it is
// above the ones shown. Its reply is the event it was quoted from (a draft taken back in the window that saved it keeps it,
// draftLinks). Not found (the steps loaded again, another chat, a draft from another window or before a reload), or further
// up than GROW_MAX steps: it says so. The wider window is keepIn's grown
// one (review: it goes back to its size once the reader follows the bottom, so streaming does not redraw the whole span).
// s.mark: the marked reply, drawn with quote-src from state so a redraw meanwhile keeps the mark.
function showSource(s, p, q) {
  const list = s.events.filter(e => e.t !== 'approval' && e.t !== 'question');
  const i = q?.ev ? list.indexOf(q.ev) : -1;
  if (i < 0) return outer.toast({ kind: 'chat', txt: q?.chat && q.chat !== s.id ? 'The reply this quote came from is in another chat.' : 'This quote\'s link to its reply is not available in this window.' }, true);
  const want = list.length - i;
  if (want > GROW_MAX) return outer.toast({ kind: 'chat', txt: 'The reply this quote came from is too far up to jump to. Scroll up with Show earlier.' }, true);
  const mark = s.mark = { ev: list[i] }; outer.setTimeout(() => { if (s.mark === mark) { s.mark = null; renderChats(); } }, 1600); // each jump its own
  const was = s.tail; if (want > (s.tail || TAIL)) s.tail = want;
  renderChats();
  const el = p.querySelector(`.hist [data-at="${s.events.indexOf(list[i])}"]`);
  // Instant, not the history's smooth scroll: a repaint mid-scroll would see the reader still at the bottom and shrink it back.
  el?.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (el) { el.classList.remove('quote-src'); void el.offsetWidth; el.classList.add('quote-src'); } // a second click restarts it
  if (s.tail !== was) s.grown ??= was || 0; // after the scroll: keepIn on a reader still at the bottom would undo it first
}

// A2 step 7: drafts saved aside with Ctrl+S in the box, newest first, in this machine's window storage, so any chat can take
// one back. The menu (drafts.mjs) loads on first use. ponytail: text and quotes (with their comments), the last 20 kept; files
// stay in the box. Only the quotes' words and comments are stored; which reply each came from is kept in this window
// (draftLinks, by draft id), so a chip taken back here still shows its reply. ponytail: lost on a reload; then it says so.
const DRAFTS = 'p9-drafts';
let draftsCount = null; // review: the button's count, read again only after a write or another window's change
window.addEventListener('storage', e => { if (e.key === DRAFTS) { draftsCount = null; keepLinks(storedIds()); renderChats(); } }); // another window saved or took one
const draftsN = () => draftsCount ??= (() => { try { return JSON.parse(localStorage.getItem(DRAFTS) || '[]').length || 0; } catch { return 0; } })();
// The whole list in one write, so a full store changes nothing (the box and the list stay as they were). false: not written.
const putDrafts = (d, add) => { draftsCount = null; const list = d.slice(0, 20);
  try { localStorage.setItem(DRAFTS, JSON.stringify(list)); } catch { return false; }
  if (add) draftLinks.set(add.id, add.links); keepLinks(new Set(list.map(x => x.id))); return true; };
const storeFull = what => outer.toast({ kind: 'draft not saved', txt: `The window storage is full, so ${what}.`, level: 'warn' }, true);
const withChips = s => s.images?.length ? 'Saved as a draft; the attached files stay in the box.' : '';
// draftLinks: draft id -> its quotes' { ref, chat }, ref a WeakRef to the reply (a chat closed or reloaded lets it go). Only
// drafts still stored (review): added once putDrafts has written that draft (add, from linksOf), pruned after every write and
// another window's.
const draftLinks = new Map();
const linksOf = (s, d) => s.quotes?.length ? { id: d.id, links: s.quotes.map(({ ev, chat }) => ({ ref: ev && new WeakRef(ev), chat })) } : null;
const keepLinks = ids => { for (const id of draftLinks.keys()) if (!ids.has(id)) draftLinks.delete(id); };
const storedIds = () => { try { return new Set(JSON.parse(localStorage.getItem(DRAFTS) || '[]').map(x => x?.id)); } catch { return new Set(); } };
const boxDraft = (s, ta) => { const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  return { id, text: ta.value, at: Date.now(), ...(s.quotes?.length ? { quotes: s.quotes.map(({ text, comment }) => ({ text, comment })) } : {}) }; };
function putAside(s, ta) {
  let d; try { d = JSON.parse(localStorage.getItem(DRAFTS) || '[]'); if (!Array.isArray(d)) d = []; } catch { d = []; }
  const nd = boxDraft(s, ta);
  if (!putDrafts([nd, ...d], linksOf(s, nd))) return storeFull('the draft stays in the box');
  const p = ta.closest('.pane'), note = withChips(s);
  ta.value = s.draft = ''; s.quotes = []; s.recall = null; renderChats(); p?.querySelector('.composer textarea')?.focus();
  if (note) outer.toast({ kind: 'draft saved', txt: note }, true);
}
// Bound to the pane it was opened from (review): nothing opens or is taken once that pane shows another chat, is hidden, sits
// under a dialog, or its box is disabled. take: the picked draft and the list without it; the box's own text, if any, goes on
// that list in the same write.
const draftsOf = (s, p) => import('./drafts.mjs').then(m => {
  const ta = () => p.querySelector('.composer textarea'), shown = aliveIn(s, p), alive = () => shown() && !!ta() && !ta().disabled;
  if (alive()) m.draftsMenu({ host: p.closest('dialog') || document.body, rect: (p.querySelector('[data-drafts]') || p.querySelector('[data-attach]')).getBoundingClientRect(), key: DRAFTS, alive,
    take: ({ id, text, quotes }, rest) => {
      const links = draftLinks.get(id) || []; // before the write prunes it
      const cur = ta().value.trim() || s.quotes?.length ? [boxDraft(s, ta())] : [], note = cur.length && withChips(s);
      if (!putDrafts([...cur, ...rest], cur[0] && linksOf(s, cur[0]))) return storeFull('nothing changed: the box and the drafts are as they were'), false;
      s.draft = text; s.quotes = (quotes || []).map(({ text, comment }, i) => ({ text, comment, ev: links[i]?.ref?.deref(), chat: links[i]?.chat })); s.recall = null; renderChats();
      const b = ta(); if (b) { b.value = text; b.focus(); b.setSelectionRange(text.length, text.length); }
      if (note) outer.toast({ kind: 'draft saved', txt: note }, true);
      return true;
    },
    remove: rest => { if (!putDrafts(rest)) return storeFull('the draft was not deleted'), false; renderChats(); return true; },
    back: () => ta()?.focus() });
}, () => outer.toast({ kind: 'chat', txt: 'The drafts did not load. Try again.', level: 'bad' }, true));
function addImages(s, files) {
  const run = (adding.get(s.id) ?? Promise.resolve()).catch(() => {}).then(() => attachNow(s, files)); adding.set(s.id, run);
  run.finally(() => adding.get(s.id) === run && adding.delete(s.id)).catch(() => {}); return run; // true: every file attached
}
async function attachNow(s, files) {
  const m = await import('./attach.mjs').catch(() => null);
  if (!m) return outer.toast({ kind: 'not attached', txt: 'Could not load attaching; nothing was attached. Try again.', level: 'warn' }, true), false;
  const { attachFull, readAttachment, tooBig } = m; let ok = true; // true: every file attached
  for (const file of files) {
    const full = attachFull(file, s.images ||= []); if (full) { ok = false; outer.toast({ kind: 'not attached', txt: full + '.', level: 'warn' }, true); continue; }
    try { // checked again against the list as it is now: a send refused or a message taken back meanwhile replaced it
      const got = await readAttachment(file, s.images), late = attachFull(file, s.images ||= []) || tooBig(got, s.images); if (late) throw new Error(late); s.images.push(got);
    }
    catch (e) { ok = false; outer.toast({ kind: 'not attached', txt: file.name + ': ' + (e?.message || e) + '.', level: 'warn' }, true); }
  }
  renderChats(); return ok;
}
// The composer's send (go) and an artifact's Send comments (item 19) share it: queued behind a running turn, or sent.
// Review round 8: not while the chat loads (stub, or events buffered behind its load): it would send in the default mode, or
// steer into a turn it does not know of yet. The box keeps the text; Send says why.
const loading = s => !!(s.stub || s.behind);
const canSend = (s, t, now) => !!s && !((!t && !(s.images?.length && (!busy(s) || now))) || s.readonly || loading(s) || s.state === 'moving' || s.state === 'moved');
// Review round 9: one typed while an earlier message waits in the daemon's hold goes behind it ('queue'), not past it by steering.
// from: a send made with quote chips, { draft, quotes }, so a refusal gives them back (liveChat.prompt); it goes with this send only.
function sendText(s, t, now, when, from) {
  const mid = !now && busy(s);
  localStorage.removeItem('p9-queue:' + s.id); // oldQueue's text was in the box: it is this send now, or let go
  if (!now && !s.live && busy(s)) { s.queue.push({ t, at: Date.now() }); renderChats(); return; }
  (now ? interrupt : outer.startTurn)(s, t, mid ? when || (s.held?.length || s.sending ? 'queue' : 'steer') : undefined, from); // one still on its way may be held
}
// O255: a live chat's interrupt is the daemon's: it holds the message first, stops the turn, and sends it at that end.
function interrupt(s, t, _, from) {
  if (!busy(s) || s.live) return outer.startTurn(s, t, s.live && 'now', from);
  cancelTurn(s); outer.startTurn(s, t, undefined, from);
}
function cancelTurn(s, quiet) {
  // CP7: no turn to cancel (it ended, or its end never came) means idle: the chat stops showing working and an
  // interrupt's message, queued first, goes now.
  // Review rounds 7-8: a turn started since the cancel (its count moved, or a prompt still in flight) keeps its Working
  // state and sends the queue at its end. The count is kept outside the chat, so a jump's rebuild cannot set it back.
  if (s.live) { const t = turnsOf.get(s.id); if (!quiet) s.stops = {}, outer.liveChat.call('cancel', { id: s.id }).then(r => { if (r.status === 409 && r.body?.error === 'no-turn' && turnsOf.get(s.id) === t && !s.sending) { s.working = s.prompted = false; turnEnd(s, free(s)); } }); return; }
  s.turn = (s.turn || 0) + 1; s.streaming = false; // stale timers see a new turn number and stop
  s.events = s.events.filter(e => !(e.t === 'tool' && e.status === 'in_progress'));
  if (!quiet) s.events.push({t:'notice', text:'Turn cancelled.'});
}
// The end of a turn applies a queued mode, then sends the next queued message.
// Threat model row 21 (no notice when a turn ended): a live turn-end nobody is watching leaves an
// "<agent> finished" card, and a desktop notice while the window is in the background. Only P9's words, never reply text.
function finished(s) {
  if (s.queue.length) return;
  const onScreen = document.hasFocus() && (outer.S.focus === 'chat' && (outer.S.split ? outer.S.open.slice(0, 2) : outer.S.open.slice(0, 1)).includes(s.id) || outer.mdl.open && outer.S.modal?.kind === 'chat' && outer.S.modal.id === s.id);
  if (onScreen) return;
  s.done = true; outer.keepUnseen();
  if (!document.hasFocus() && typeof Notification === 'function') { const n = new Notification(outer.names[s.agent] + ' finished', { body: s.title }); n.onclick = () => { window.focus(); outer.openModal({ kind: 'chat', id: s.id }, 'done' + s.id); }; }
}
// Every queued-message send that is not the person's own click asks free(): not stopped or moving (the daemon would
// resume the chat). Review round 8: whether a turn runs is the daemon's to say, not this window's guess (an unprompted
// run's end never reaches it, a refused prompt leaves Working on): the send goes as when 'queue', so the daemon holds it
// for a turn running there and sends it at that turn's end, and starts it when none runs.
let plainPaste = null; // the composer whose Ctrl Shift V is pasting now (A2 step 1)
const turnsOf = new Map(), sentImgs = new Map(), takenBack = new Map(); // chat id -> 'user' events applied (cancelTurn); sentImgs, takenBack: carry (takenBack: id -> its files go back, for a 202 that comes after the event. ponytail: ids whose 202 never comes here, other windows' and text-only ones, stay for the page's life; a few bytes each)
const free = (s) => !['stopped', 'stopping', 'moved', 'moving'].includes(s.state);
// send false: the turn's artifact and mode change still happen, but no queued message goes (free()).
function turnEnd(s, send = true) {
  autoArtifact(s);
  if (s.modeNext) { setMode(s, s.modeNext); s.modeNext = null; s.events.push({t:'notice', text:'Mode is now ' + modeNow(s) + '.'}); }
  if (send && s.queue.length) outer.startTurn(s, s.queue.shift().t, 'queue'); else { outer.renderTabs(); renderChats(new Set([s.id])); } // an interrupt may queue '' (images only)
}
function reply(s, text) {
  const turn = s.turn = (s.turn || 0) + 1; s.streaming = true;
  outer.setTimeout(() => { if (s.turn !== turn) return; s.events.push({t:'agent', text:''}); const ev = s.events[s.events.length - 1]; let i = 0;
    const tick = () => { if (s.turn !== turn) return; i += 3; ev.text = text.slice(0, i); if (i < text.length) { renderChats(); outer.setTimeout(tick, 18); } else { s.streaming = false; turnEnd(s); } }; tick(); }, 500);
}
const dataNote = () => { outer.$('#dataNote').textContent = [outer.live.on && !outer.serverInfo?.slim && 'Mission Control live', outer.liveChat.on && 'Chat live', !outer.liveChat.on && (outer.sampleView ? 'Chat sample data' : 'Chat waiting for the daemon'), outer.sampleView && 'Dev sample data'].filter(Boolean).join(' · '); };
const chatModel = { claude: 'Claude Code · ACP', codex: 'Codex · ACP' };
// CAT-1f: GET /agents fills the agents' names, modes and chat model (controller names, helpers modes, chatModel) once it
// answers, so the pickers offer every catalog agent; until then, and in the sample view, they hold the two built in. Called
// once, from list(); a failed read (the daemon still starting) asks again every 10 s and redraws. The window and its daemon
// ship together, so the catalog only adds agents and the two built in are never taken out.
// An id goes into HTML attributes, so only a-z 0-9 - is taken (agents.mjs keeps its ids to that).
const loadAgents = async () => { const r = await window.p9.chat('agents', {}).catch(() => 0);
  if (r?.status !== 200) return outer.setTimeout(() => loadAgents().then(() => (refreshPill(), renderChats())), 1e4);
  const agents = r.body.agents.filter(a => /^[a-z0-9-]+$/.test(a.id));
  for (const a of agents) outer.names[a.id] = a.short || a.name, modes[a.id] = a.modes.map(m => m.name), chatModel[a.id] = a.name + ' · ACP';
  fillLoose(agents); };
const toolDiff = content => { const rows = diffRows(content, 200); return rows.length ? rows : null; };
// PH1: the phone link for this chat, on the daemon's own remote address (its --remote-origin, none with remote logins off).
async function continueOnPhone(s) {
  const r = await window.p9?.chat?.('missionFiles', {}).catch(() => null);
  // O116: phone-link.mjs (with qrcode-generator, about 44 KB) loads here, on the first open, not at shell startup.
  // A failed load says so in the dialog; Try again calls import() afresh (nothing keeps the rejected promise).
  const mod = await import('./phone-link.mjs').catch(() => null), body = outer.$('#phoneBody'), dlg = outer.$('#phoneDlg');
  if (mod) body.innerHTML = mod.phoneDialogBody(r?.status === 200 ? r.body.remoteOrigin : '', s.id);
  else {
    body.innerHTML = '<p role="status">Cannot show the phone link right now.</p><p><button data-slot="button" type="button" data-phone-retry>Try again</button></p>';
    body.querySelector('[data-phone-retry]').onclick = () => continueOnPhone(s);
  }
  if (!dlg.open) dlg.showModal();
}
// A web link in a reply (made by helpers.mjs mdReply, row 18): the window never navigates, so main opens it in the browser,
// after a question showing the whole address; "don't ask again"
// is kept on this computer.
const linkOk = href => localStorage.getItem('p9-link-ok') ? Promise.resolve(true) : new Promise(done => {
  const d = outer.$('#linkDlg'); outer.$('#linkU').textContent = href; d.returnValue = '';
  d.onclose = () => { if (d.returnValue === 'never') localStorage.setItem('p9-link-ok', '1'); done(d.returnValue === 'yes' || d.returnValue === 'never'); };
  d.showModal();
});
// Chat files: the files an edit call (Write, Edit, NotebookEdit; ACP kind edit, both adapters) wrote, from its rawInput, locations
// and diffs, as the agent named them (absolute, or relative to the chat's folder). Created: a diff that made its file (diffCreated), else a Write.
// Deleted (O121 part 4b): a v2 diff that removed it (diffDeleted); an update with no diff for it keeps the mark it had (#423 FIX1),
// a later diff for it decides again; across calls the newest write's mark wins.
// ponytail: a Write over a file that was already there, with no diff, reads as created.
// Each file keeps its own line diff for the Changes tab (an update with no content keeps the one it had).
// ponytail: up to 2,000 rows a file, against the chat's 200.
const editFiles = (d, tool) => {
  if (tool.kind !== 'edit') return tool.files;
  const diffs = (Array.isArray(d.content) ? d.content : []).filter(c => c?.type === 'diff' && typeof c.path === 'string');
  const rows = p => { const r = diffRows(diffs.filter(c => c.path === p), 2000); return r.length ? r : tool.files?.find(f => f.path === p)?.diff; };
  const paths = [d.rawInput?.file_path, d.rawInput?.notebook_path, ...(Array.isArray(d.locations) ? d.locations.map(l => l?.path) : []), ...diffs.map(c => c.path), ...(tool.files ?? []).map(f => f.path)].filter(p => typeof p === 'string' && p);
  const was = p => tool.files?.find(f => f.path === p), created = p => { const c = diffs.find(c => c.path === p); return c ? diffCreated(c) : was(p)?.created ?? /^Write\b/.test(tool.title); };
  const deleted = p => { const c = diffs.find(c => c.path === p); return c ? diffDeleted(c) : !!was(p)?.deleted; };
  return paths.length ? [...new Set(paths)].slice(0, 50).map(p => ({ path: p, created: created(p), ...(deleted(p) && { deleted: true }), diff: rows(p) })) : tool.files;
};
const toolText = content => (content || []).filter(c => c.type === 'content' && c.content?.type === 'text').map(c => c.content.text).join('\n').slice(-4000);
// Item 19, plan view: Claude's plan-mode plan (ExitPlanMode: the adapter's "Approve Plan" call, kind switch_mode), kept whole.
const planText = d => d?.kind === 'switch_mode' && (d.content || []).filter(c => c.type === 'content' && c.content?.type === 'text').map(c => c.content.text).join('\n').slice(0, 200000) || undefined;
// O255: a live chat's waiting messages are the daemon's (s.held, from its events), one list for every window and the phone;
// s.queue is only a demo chat's. One an older build queued in this window (localStorage p9-queue:) goes into the box, until a send from that chat.
const oldQueue = id => { try { const draft = JSON.parse(localStorage.getItem('p9-queue:' + id)).map(x => x.t ?? x).filter(String).join('\n'); return draft ? { draft } : {}; } catch { return {}; } }; // not a list (or none): nothing
const liveSession = (id, provider, title, folder, created, project = null, profile = null) => ({ id, agent: provider, title, project, profile, model: profile?.model || chatModel[provider], mode: outer.startMode(provider), queue: [], effort: 'Medium', state: 'idle', pending: null, context: null, limits: { h5: 0, d7: 0 }, cacheMin: null, cwd: folder || 'P9 workspace', folder: folder || '', events: [], live: true, created, ...oldQueue(id) });
// E2, O249: a chat at launch is only listed (stub); its events load the first time it is shown (or by late() in loadChat), or before
// the next event for it is applied. Up to until, so nothing the main loop applies comes twice; retried until it loads.
function history(s, until = outer.liveChat.cursor) {
  return s.loading ||= (async () => {
    for (let after = 0; !outer.lifetime.signal.aborted;) {
      // A call that throws (the window's bridge dropped it) is retried like a refused one; a load that rejected would stay stuck.
      const r = await window.p9.chat('events', { after, only: [s.id], until, ...(after ? {} : { tail: TAIL }) }).catch(() => ({}));
      // ponytail: refused (an ID that is not a UUID, which only a seeded test ledger has) leaves the chat empty, not stuck.
      if (r.status === 400) break;
      if (r.status !== 200) { await new Promise(res => outer.setTimeout(res, 2000)); continue; }
      const was = s.state; // review round 9: a Stop clicked while this loads stays; history is older than it
      // A2 step 5: so does the goal the list gave (read after this history's cursor): an older goal in it is not drawn again.
      // A daemon from before the list's goal (undefined, not null) leaves it to the history.
      const goal = s.goal;
      // A2 step 3: the open edit's own save (its op) in the replay settles it, as live; a replay's other events do not (carry).
      for (const ev of r.body.events) { try { applyChat(ev); } catch {} if (ev.type === 'held-text' && ev.data?.op && ev.data.op === s.hedit?.op) editSeen(s, ev); }
      if (was === 'stopping') s.state = was;
      if (goal !== undefined) s.goal = goal;
      // An ask loaded from history was there before: it goes to the bell without its notice (bell-notice.mjs). Review round
      // 8: by its request, so a new ask of the same kind after it was answered is new.
      s.pendingOld = askId(s);
      if (r.body.more) { tailed(s, r.body); break; }
      after = r.body.cursor;
      if (r.body.events.length < 500) break;
    }
    // A2 step 3: an open edit whose message left in events no carry saw (a catch-up skips them, O251). A save in flight is
    // settled by its answer instead (heldText below).
    // One still waiting meets its newest words (an untouched editor moves to them), as its held-text event would.
    const h = s.hedit && s.held?.find(h => h.id === s.hedit.id);
    if (h) editSeen(s, { type: 'held-text', data: { id: h.id, text: h.text } });
    else if (s.hedit && s.hedit.saving == null) editGone(s, false);
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
  const from = s.more, r = await window.p9.chat('events', { after: 0, only: [s.id], until: from - 1, tail: TAIL });
  // O251: a jump meanwhile made the chat a stub and read it again from its newest blocks; this page would skip what lies between.
  if (r.status !== 200 || s.more !== from) return;
  const old = { ...liveSession(s.id, s.agent, s.title, s.folder, 0), queue: [] };
  for (const ev of r.body.events) if (!s.early?.has(ev.cursor)) try { applyChat(ev, old); } catch {}
  s.events = [...old.events, ...s.events];
  tailed(s, r.body);
}
// A2 step 3: the open edit (s.hedit) against one live event, in stream order. Its own save's held-text (its op) closes it (saved);
// another window's moves an untouched editor along and leaves typing alone. Its message leaving closes it: words the daemon
// does not have (text != base) go into the box, so none are lost, and a take-back brings those instead of the old words.
// Returns the take-back's words for the box, or undefined.
function editSeen(s, ev) {
  const ed = s.hedit, d = ev.data; if (!ed || !d) return;
  // Its own save, also after an answer that was unsure: saved, and words typed since stay open on top of it, not a conflict.
  if (ev.type === 'held-text' && d.id === ed.id && d.op && d.op === ed.op) { if (ed.lost != null) s.events.push({ t: 'notice', text: 'Your edit that got no sure answer was saved.' }); if (ed.saving != null || ed.text === d.text) s.hedit = null; else { ed.was = ed.base = d.text; ed.lost = null; } return; }
  if (ev.type === 'held-text' && d.id === ed.id) { if (ed.text === ed.was) ed.text = ed.was = d.text; ed.base = d.text; return; }
  if (!(ev.type === 'unheld' ? [d.id] : ev.type === 'user' ? d.held || [] : []).includes(ed.id)) return;
  return editGone(s, ev.type === 'unheld' && ['removed', 'cancelled'].includes(d.why));
}
// A take-back keeps any change, an emptied caption too.
function editGone(s, back) {
  const ed = s.hedit, changed = ed.text !== ed.base; s.hedit = null;
  if (back) return changed ? ed.text : undefined;
  if (changed && ed.text.trim()) { s.draft = ed.text + (s.draft ? '\n' + s.draft : ''); s.recall = null; s.events.push({ t: 'notice', text: ed.text === ed.lost ? 'The queued message left while your edit\'s save had no answer, so it may have gone with these words. They are in the box; check before sending.' : 'The queued message left before your edit was saved. Your edit is in the box.' }); }
}
// Applies one daemon event to S (or to into, Show earlier's older blocks); returns the session when a turn ended (so queued messages can go).
function applyChat(ev, into) {
  const d = ev.data;
  if (ev.type === 'created') { if (!into && !outer.S.sessions.some(x => x.id === ev.conversation)) { const s = liveSession(ev.conversation, d.provider, d.title, d.folder, ev.at, d.project, d.profile); if (d.parent) s.parent = d.parent; outer.claimFresh(s, d.op); outer.S.sessions.push(s); } return null; }
  const s = into ?? sess(ev.conversation); if (!s) return null;
  // Last used, as the daemon's list counts it (History's order); a stub's older history can load after newer events.
  if (!NOT_USE.includes(ev.type)) s.used = Math.max(s.used || 0, ev.at);
  const last = s.events[s.events.length - 1], notice = text => s.events.push({ t: 'notice', text });
  const settle = () => { s.working = s.prompted = false; s.pending = null; s.events = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'); };
  switch (ev.type) {
    case 'user': if (typeof d.note === 'string') notice('P9 told the agent: ' + d.note.trim()); s.events.push({ t: 'user', text: d.text, images: d.images, files: d.files, when: new Date(ev.at).toTimeString().slice(0, 5), ...(d.ask && { ask: d.from ?? true }), ...(d.info && { info: d.from ?? true }), ...(d.from && { from: d.from, fromTitle: d.fromTitle }), ...(d.repeat === true && { repeat: true }) }); if (!s.profile?.gone) s.state = 'running'; s.working = s.prompted = s.sent = true; if (!into) turnsOf.set(s.id, (turnsOf.get(s.id) || 0) + 1);
      if (Array.isArray(d.held)) s.held = s.held?.filter(h => !d.held.includes(h.id)); break;
    // CP1: a message the daemon holds for this turn (composer.mjs), and its going back: taken back with its x or by a
    // cancel (loadChat puts the text back in the box), or not sent at all.
    case 'held': (s.held ||= []).push({ id: d.id, text: d.text, when: d.when, at: ev.at, ...(d.info && { info: true }), ...(d.fixed && { fixed: true }) }); break;
    case 'held-text': for (const h of s.held || []) if (h.id === d.id) h.text = d.text; break;
    // A note from another chat that waits for this chat's next message: shown where it arrived; it started nothing.
    case 'note': s.events.push({ t: 'user', text: d.text, when: new Date(ev.at).toTimeString().slice(0, 5), info: d.from ?? true, fromTitle: d.fromTitle }); break;
    case 'unheld': s.held = s.held?.filter(h => h.id !== d.id); if (d.why !== 'removed' && d.why !== 'cancelled' && d.why !== 'noted') notice('Not sent (' + d.why + '): ' + d.text); break;
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
    case 'card': case 'unpin': applyCard(s, ev.type, d); if (ev.type === 'card' && isReport(String(d.id))) s.events.push({ t: 'report', id: String(d.id), text: String(d.text ?? '') }); break; // AR2: pin_card and unpin_card, pinned above the composer
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
      // turn nobody prompted (a background task's wake-up left the clock at 57 min) and a long prompted
      // turn alike (an agent working on its own for hours inside one turn left it cold); turn-end sets it once more.
      if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(d.sessionUpdate)) s.lastEnd = ev.at;
      if (d.sessionUpdate === 'agent_message_chunk' || d.sessionUpdate === 'agent_thought_chunk') {
        const t = d.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought', text = d.content?.type === 'text' ? d.content.text : '', img = t === 'agent' && imgSrc(d.content), warn = t === 'agent' && agentWarning(text);
        if (warn) s.events.push({ t: 'warn', text: warn }); // the adapter's warning, a notice line above the reply (helpers.mjs)
        else if (last?.t === t) { last.text += text; if (img) (last.images ||= []).push(img); } else s.events.push({ t, text, ...(img && { images: [img] }) });
      } else if (d.sessionUpdate === 'tool_call') { const tool = { t: 'tool', id: d.toolCallId, status: typeof d.status === 'string' ? d.status : 'pending', title: String(d.title || 'Tool call'), kind: d.kind, diff: toolDiff(d.content), output: toolText(d.content), images: toolImages(d.content), plan: planText(d) }; tool.files = editFiles(d, tool); s.events.push(tool); }
      else if (d.sessionUpdate === 'tool_call_update') { const tool = s.events.find(e => e.t === 'tool' && e.id === d.toolCallId); if (tool) { if (typeof d.status === 'string') tool.status = d.status; if (d.title) tool.title = String(d.title); if (typeof d.kind === 'string') tool.kind = d.kind; tool.files = editFiles(d, tool); if (d._meta?.['p9/append'] === true) tool.output = ((tool.output ?? '') + toolText(d.content)).slice(-4000); else if (d.content) { tool.diff = toolDiff(d.content); tool.output = toolText(d.content); tool.images = toolImages(d.content); } const exit = exitTag(d._meta?.['p9/exit']); if (exit) tool.exit = exit; } } // O219: a command's streamed output comes as pieces to add; O220: a failed or killed one's exit, a tag
      else if (d.sessionUpdate === 'available_commands_update' && Array.isArray(d.availableCommands)) s.commands = outer.lastCommands[s.agent] = d.availableCommands.slice(0, 1000).map(c => ({ name: String(c?.name ?? ''), desc: String(c?.description ?? '') })).filter(c => c.name);
      // O126: the agent's own title only on a chat the user never named. O172: nor on a sprint chat's role name (the list's named, sprintFields).
      else if (d.sessionUpdate === 'session_info_update') { if (!s.named && typeof d.title === 'string' && d.title.trim()) s.title = d.title.replace(/\s+/g, ' ').trim().slice(0, 120);
        // A2 step 5: the agent's goal, as the daemon reads it (chat.mjs goalOf): null clears it, junk leaves the last one. Its
        // status shows when not active (the Claude adapter sends only active, and a met goal comes as a clear).
        const air = d._meta?.jetbrains?.air, g = air && typeof air === 'object' && Object.hasOwn(air, 'goal') ? air.goal : undefined;
        if (g === null) s.goal = null; else if (typeof g?.objective === 'string' && g.objective.trim()) s.goal = { objective: g.objective.trim().slice(0, 2000), status: typeof g.status === 'string' && g.status ? g.status.slice(0, 20) : 'active' }; }
      else if (d.sessionUpdate === 'usage_update' && d.size > 0) { s.context = { used: Number(d.used) || 0, size: Number(d.size) }; if (d._meta?.['_claude/rateLimit']) outer.usageNow(); }
      else if (d.sessionUpdate === 'plan') { const entries = (Array.isArray(d.entries) ? d.entries : []).map(x => [String(x?.status), String(x?.content ?? '')]), plan = s.events.find(e => e.t === 'plan'); if (plan) plan.entries = entries; else s.events.push({ t: 'plan', entries }); }
      break;
    case 'approval': s.events.push({ t: 'approval', at: ev.at, request: d.request, title: d.toolCall?.title || 'Tool call', diff: toolDiff(d.toolCall?.content) || [], options: d.options.map(o => [o.optionId, o.name, o.kind]), plan: planText(d.toolCall) }); s.pending = 'approval'; break;
    case 'question': {
      // The daemon's form (formSpec in chat.mjs) is the one P9 renders and checks; null means P9 cannot show it faithfully.
      // A required choice starts unpicked; an optional one starts on "No answer" (left out of the reply).
      const field = f => {
        const radio = options => f.required ? { kind: 'radio', options, def: null } : { kind: 'radio', options: [['', 'No answer'], ...options], def: '' };
        const shape = f.kind === 'choice' ? radio(f.options) : f.kind === 'boolean' ? radio([['true', 'Yes'], ['false', 'No']]) : f.kind === 'multi' ? { kind: 'multi', options: f.options } : { kind: 'text' };
        return { ...shape, key: f.key, label: f.label, hint: f.hint, required: f.required, type: f.kind };
      };
      s.events.push({ t: 'question', at: ev.at, request: d.request, title: d.message, unsupported: !d.form, fields: d.form ? d.form.fields.map(field) : [] }); s.pending = 'question'; break; }
    case 'answered': {
      // phone-3: the button's own words, not its internal id (the id only when the approval is not in this replay).
      const id = d.answer.outcome?.optionId, option = s.events.find(e => e.request === d.request)?.options?.find(o => o[0] === id);
      s.events = s.events.filter(e => e.request !== d.request); s.pending = s.events.some(e => e.t === 'approval') ? 'approval' : s.events.some(e => e.t === 'question') ? 'question' : null;
      notice(d.answer.outcome ? (d.answer.outcome.outcome === 'selected' ? 'You chose: ' + (option?.[1] || id) : 'Approval cancelled') : 'Question: ' + d.answer.action); break; }
    case 'lock-rejected': notice((d.ask ? 'Answering another chat (read-only): rejected ' : 'Agent lock: rejected ') + (d.toolCall?.title || 'a tool call')); break;
    case 'restart-request': s.events.push({ t: 'notice', text: 'The agent asks you to restart P9: ' + d.reason, restart: true }); break; // RS2: with a Restart button
    case 'steer-lost': notice('This message may not have reached the agent: ' + d.text); break;
    case 'turn-end': settle(); s.lastEnd = ev.at; outer.usageNow(); outer.queueSoon(); if (d.stopReason !== 'end_turn') notice('Turn ended: ' + d.stopReason); return s;
    // Review rounds 8-10: an error that ends a prompt (ends: the daemon's prompt-error and refused-setting paths, which send no
    // turn-end) closes the turn the same way. Any other (a refused hand-off mid-turn) keeps the turn and its ask; it clears
    // Working as before, which the agent's next output sets again, and an older ledger's errors (no ends) still clear it.
    case 'error': s.events.push({ t: 'error', text: d.message }); s.working = false; if (d.ends && s.prompted && !into) { settle(); return s; } break;
    // N1: the daemon's word on a chat's project, title, archive and removal, for every window (apps/server/projects.mjs).
    case 'project': s.project = d.project ?? null; s.folderAsked = false; break;
    case 'renamed': s.title = d.title; s.named = true; break;
    case 'archived': s.archived = !!d.archived; break;
    case 'askable': s.askable = !!d.on; break;
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
  // O249: launch reads no chat's events before the list draws: a tail of no chats answers with the newest cursor (as jump()
  // does), every chat comes from the list as a stub, the shown ones load their newest blocks (renderChats -> history), and
  // the other open chats load after, one at a time (late, below). Before, launch replayed every open chat first (E2, P20),
  // and a busy chat's screenshots held the whole window empty for 45 s over a remote.
  let replaying = true, scope = null;
  // O47: the list reply carries each agent's lists; while the daemon reads them fresh, ask again until it is done.
  let asking = false;
  const lists = async body => { if (!outer.takeLists(body?.lists) || asking) return; asking = true;
    for (let i = 0; i < 60 && !outer.lifetime.signal.aborted; i++) { await new Promise(res => outer.setTimeout(res, 1500)); const l = await window.p9.chat('list', {}); if (l.status === 200 && !outer.takeLists(l.body.lists)) break; }
    asking = false; refreshPill(); renderChats();
    // Settings or the New menu open while the lists were read: the Default model and effort rows, and the menu's rows, fill in.
    if (outer.$('#setDlg')?.open) outer.refreshDefaults();
  };
  const list = async () => { let l; while ((l = await window.p9.chat('list', {})).status !== 200 && !outer.lifetime.signal.aborted) await new Promise(res => outer.setTimeout(res, 2000)); await loadAgents(); lists(l.body); await outer.loadProfiles(); await outer.loadStarts(); return l.body?.conversations || []; };
  let sprintStale = false, sprintAt = 0;
  // The sessions from the list, once caught up: a chat not held here comes as a stub, and each one's archive, project and
  // sprint fields come from the list. After the launch's replay, and after a jump (O251), whose skipped events made chats too.
  // A chat from the daemon's list, not loaded yet (its events read when opened). O251: the launch and jump() both make them.
  const stubOf = (c) => ({ ...liveSession(c.id, c.provider, c.title, c.folder, c.created, c.project, c.profile), state: c.state, stub: true, sent: c.sent, used: c.used, parent: c.parent ?? null, archived: !!c.archived, askable: !!c.askable, goal: c.goal });
  const lastTwo = () => { if (!outer.S.open.length) outer.S.open = outer.S.sessions.filter(s => !s.hidden).slice(-2).reverse().map(s => s.id); };
  const caughtUp = (listed) => {
    // Tabs keep the order the chats were made in; History sorts by last used.
    const all = [...listed].sort((a, b) => a.created - b.created), have = new Map(outer.S.sessions.map(s => [s.id, s]));
    // 712: a stub carries its archive too; without it, after a restart an archived chat came back to the card and the sidebar.
    outer.S.sessions = [...all.map(c => { const h = have.get(c.id); if (h && c.profile) h.profile = c.profile; return h || { ...stubOf(c), ...sprintFields({}, c) }; }), ...outer.S.sessions.filter(s => !all.some(c => c.id === s.id))];
    // N1: a chat's project and archive come from the list too (a tailed replay can leave their events out). So does its goal (A2). O126: so does a
    // name the user gave (its renamed event may be out of the tail, and the agent's title in it), through sprintFields.
    for (const c of all) { const s = have.get(c.id); if (s) { s.project = c.project ?? null; s.archived = !!c.archived; s.askable = !!c.askable; s.parent = c.parent ?? null; if (Object.hasOwn(c, 'goal')) s.goal = c.goal; sprintFields(s, c); } }
    outer.loadProjects?.();
    // N1: a result not seen yet (unread or failed) stays unseen over a restart; renderChats saves the list from now on.
    try { const u = JSON.parse(localStorage.getItem('p9-unseen') || '{}'); for (const x of outer.S.sessions) if (u[x.id]) x[u[x.id]] = true; } catch {}
    unseenKept = outer.S.loaded = true; // 733: from here a new ask or finish shows a notice (renderCards)
    // A chat closed here before 0.1.5 that never started stops now, so other windows drop it too; a running one keeps
    // running (the phone may have resumed it) and gets its tab back.
    for (const s of outer.S.sessions) { s.hidden = s.state === 'stopped' || s.state === 'moved'; if (outer.closedChats.has(s.id) && s.state === 'idle') { s.hidden = true; outer.liveChat.stop(s, true); } }
    outer.closedChats.clear(); localStorage.removeItem('eh-closed-chats');
    lastTwo();
  };
  // O251: each loaded chat goes back to a stub, as launch lists a stopped chat, and loads its newest blocks when shown
  // (history); the cursor moves to the newest event (a tail of no chats answers with it). What the person made here stays:
  // the box, the queue, an unseen mark; tabs follow the list as at launch (caughtUp: a stopped chat's is closed). The gap's finishes are summed: a chat not shown that was used in the
  // gap gets one unseen mark, not a notice per turn. False when the daemon did not answer, so the page is drawn as before.
  const jumpNow = async (page) => {
    const head = await window.p9.chat('events', { after: 0, only: [], tail: TAIL }), l = await window.p9.chat('list', {});
    if (head.status !== 200 || l.status !== 200) return false;
    // A late() still loading stops at its next chat (it would take the gate below and skip that chat) and starts over at the end.
    const again = lateBusy; lateRun += 1;
    // A chat's load still in flight ends first: it marks its chat loaded when done, which would land on the emptied stub. One
    // asked for meanwhile (a chat opened) gets the gate instead, so none reads up to the old cursor; the reset clears it.
    let open; const gate = new Promise(res => { open = res; }), flying = outer.S.sessions.map(s => s.loading).filter(Boolean);
    for (const s of outer.S.sessions) s.loading = gate;
    try { await Promise.all(flying.map(p => p.catch(() => {}))); } finally { outer.setTimeout(open, 0); }
    jumps += 1;
    // Review round 7: what the skipped events do in this window only (a take-back's text to the box, a failure's mark) is
    // kept: the buffered ones, then the page's. The list cannot carry them.
    const skipped = [...outer.S.sessions.flatMap(s => s.behind || []), ...page];
    const listed = l.body.conversations || [], by = new Map(listed.map(c => [c.id, c])), shown = new Set(outer.S.open);
    // Gone from the list (deleted in the gap): dropped, as a launch would. The others go back to stubs with the list's state.
    outer.S.sessions = outer.S.sessions.filter(s => by.has(s.id));
    for (const s of outer.S.sessions) {
      const c = by.get(s.id), keep = { hedit: s.hedit, queue: s.queue, draft: s.draft, images: s.images, quotes: s.quotes, stops: s.stops, sending: s.sending, failed: s.failed, done: s.done || (!shown.has(s.id) && c.used > (s.used || 0)) };
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, stubOf(c), keep);
    }
    outer.liveChat.cursor = head.body.cursor; outer.keepUnseen();
    // New chats, fields, closed tabs (a stopped chat is hidden) and kept messages for a chat whose turn ended in the gap.
    caughtUp(listed);
    for (const ev of skipped) carry(ev); // after caughtUp, so a chat made in the gap gets its own too
    outer.S.open = outer.S.open.filter(id => outer.S.sessions.some(s => s.id === id && !s.hidden));
    lastTwo();
    try { outer.renderTabs(); renderChats(); } catch (e) { console.error('chat paint', e); }
    if (again) late();
    return true;
  };
  // Review round 6: a chat's history callback (behind(), the launch drain) that comes while a jump is in flight waits for it.
  // The page that set off the jump is not applied yet (a stop in it), so the callback would see the old state and send a
  // queued message into a chat stopped meanwhile. A jump that rebuilt the chats drops the callback (its caughtUp sends kept
  // messages from the list's state); one that did not runs it after the page is applied.
  let jumps = 0, jumping = null;
  const jump = (page) => (jumping ||= jumpNow(page).finally(() => { jumping = null; }));
  const unlessJumped = (f) => { const g = jumps; return () => { const go = () => { if (g === jumps) f(); }; return jumping ? jumping.then(go) : go(); }; };
  // O249: the open chats not shown load after the list draws, shown ones first, one read at a time so the shown chat's
  // read is not shared with the rest over a slow link. Their asks were there before launch: history marks them old, so
  // they go to the bell with no notice, while an ask that comes in meanwhile still shows its notice (self-review).
  // A jump (O251) makes them stubs again; one that cuts a late() short starts it over. After late() is done, a jump leaves
  // the chats not shown as stubs until opened, as O251 does, so a wake stays one step.
  let lateRun = 0, lateBusy = false;
  const late = async () => {
    const run = ++lateRun; lateBusy = true;
    const shown = new Set(outer.S.open), open = outer.S.sessions.filter(s => s.stub && !s.hidden).sort((a, b) => shown.has(b.id) - shown.has(a.id));
    for (const s of open) { if (outer.lifetime.signal.aborted || run !== lateRun) return; try { await history(s); } catch (e) { console.error('chat history', e); } }
    if (run === lateRun) lateBusy = false;
  };
  // What a live event leaves in this window only, never from a replay (history): N1, failed (a red cross on the row and the
  // strip) until it is seen; CP1, a held message taken back goes into the box, as typed (the box keeps its own draft), and
  // O256 with the files it was sent with (sentImgs: held id -> the files, kept until it is sent or handed back).
  // ponytail: only in the window that sent it, and not over a reload; elsewhere attach them again.
  const carry = (ev) => {
    const s = sess(ev.conversation); if (!s) return;
    if (ev.type === 'error' || (ev.type === 'exited' && ev.data?.code)) { s.failed = true; outer.keepUnseen(); }
    // A2 step 3: an edit open when its message leaves is kept (editSeen): taken back, the box gets the unsaved words.
    const back = ev.type === 'unheld' && ['removed', 'cancelled'].includes(ev.data?.why), edited = editSeen(s, ev);
    if (back) { s.draft = [edited ?? ev.data.text, s.draft].filter(Boolean).join('\n'); s.recall = null; sentImgs.has(ev.data.id) || takenBack.set(ev.data.id, 1); s.images = [...sentImgs.get(ev.data.id) || [], ...s.images || []]; }
    if (ev.type === 'unheld' || ev.type === 'user') for (const h of ev.data?.held || [ev.data?.id]) if (h && !sentImgs.delete(h) && !takenBack.has(h)) takenBack.set(h, 0); // its 202 may come after
  };
  // One daemon event applied, with what follows it in this window; ended and answered_ collect what settle() does after a batch.
  const take = (ev, ended, answered_) => {
    const created = ev.type === 'created' && !replaying;
    // A malformed stored event is skipped, never thrown: it would fail again on every replay.
    let end = null; try { end = applyChat(ev); } catch { end = null; } if (end) ended.push(end);
    // A7: a worker an agent started never takes the screen from the chat being read; it is listed under its parent.
    // window-10: nor does the lead chat this window's Start sprint makes; the project page keeps the press's answer.
    if (created && !ev.data?.parent && !outer.pressedStart?.(ev.conversation) && !swapIn(ev.conversation)) show(ev.conversation, true); // not a navigation: a project click waiting for its code (O261) still runs
    if (!replaying) carry(ev);
    if (!replaying && (ev.type === 'project' || ev.type === 'deleted' || (ev.type === 'created' && ev.data?.project))) outer.loadProjects?.();
    if (ev.type === 'answered') answered_.push(ev.conversation);
    // Its x in any window takes the tab out of this one too (not on replay, which hides every stopped chat).
    const closed = !replaying && ev.type === 'closed' && outer.S.sessions.find(s => s.id === ev.conversation && !s.hidden);
    if (closed) { closed.hidden = true; untab(closed.id); }
  };
  // CP9: a throw here (a paint) used to end this loop, so the chat froze until a restart; log it and keep polling.
  // Review rounds 4-8: a turn end applied after a newer turn started (both in one poll, or buffered by behind()) sends as
  // 'queue', so the daemon holds the message for that newer turn's end. None to a chat stopped or moving by then (a stop in
  // the same poll): the daemon would resume it.
  const settle = (ended, answered_) => { try { for (const s of ended) { finished(s); turnEnd(s, free(s)); } for (const id of answered_) { const s = sess(id); if (s && !s.pending) answered(s); } } catch (e) { console.error('chat batch', e); } };
  // O249: an event for a chat not loaded yet waits with it while it loads (history up to the event before), then applies
  // in order; the loop goes on, so the shown chat's replies do not wait behind a busy chat's history over a slow link.
  // Review rounds 2-3: every buffered event applies first, so the chat's state is as it is now.
  const behind = (s, evs) => {
    if (s.behind) return void s.behind.push(...evs);
    s.behind = [...evs];
    history(s, evs[0].cursor - 1).then(unlessJumped(() => {
      const buffered = s.behind || [], ended = [], answered_ = []; s.behind = null;
      for (const e of buffered) take(e, ended, answered_);
      const end = ended.length ? [ended.at(-1)] : [];
      settle(end, answered_);
      try { outer.renderTabs(); renderChats(new Set([s.id])); } catch (e) { console.error('chat paint', e); }
    }), (e) => console.error('chat history', e));
  };
  while (!outer.lifetime.signal.aborted) {
    if (!replaying && sprintStale && Date.now() - sprintAt > 1000) { sprintStale = false; sprintAt = Date.now(); const f = await window.p9.chat('list', {}); if (f.status === 200 && sprintSync(f.body.conversations || [])) renderChats(); }
    const l = scope ? null : await window.p9.chat('list', {});
    if (l?.status === 200) { lists(l.body); scope = { only: [] }; }
    const tail = replaying && scope?.only && !outer.liveChat.cursor ? { tail: TAIL } : {};
    const r = scope ? await window.p9.chat('events', { after: outer.liveChat.cursor, ...(replaying ? { ...scope, ...tail } : { wait: 8000 }) }) : l;
    // A refused narrowed replay (a listed ID the bridge or daemon will not take) replays everything, as before E2.
    if (r.status === 400 && replaying && scope?.only) { scope = {}; continue; }
    if (r.status !== 200) { if (!outer.liveChat.on && outer.sampleView) return; await new Promise(res => outer.setTimeout(res, outer.liveChat.on ? 2000 : 5000)); continue; }
    if (!outer.liveChat.on) { outer.liveChat.on = true; outer.S.sessions = []; outer.S.open = []; dataNote(); if (waitingNew) { const a = waitingNew; waitingNew = null; newSession(...a); } }
    // O251: a full page while live means this window fell behind (a sleep, a dropped link), and drawing every update since,
    // 500 at a time, took minutes over a remote. Jump instead, as a fresh launch would (jump, below).
    if (!replaying && r.body.events.length >= 500 && await jump(r.body.events)) continue;
    const ended = [], answered_ = [], held = new Map();
    for (const ev of r.body.events) {
      // Review round 7: and while its buffer waits (a jump in flight), so nothing newer applies before it.
      const stub = outer.S.sessions.find(s => s.id === ev.conversation && (s.stub || s.behind));
      if (stub) { if (!held.has(stub)) held.set(stub, []); held.get(stub).push(ev); } else take(ev, ended, answered_);
    }
    for (const [s, evs] of held) behind(s, evs);
    outer.liveChat.cursor = r.body.cursor; if (!replaying && r.body.events.length) sprintStale = true;
    if (replaying && (r.body.more || r.body.events.length < 500)) {
      replaying = false;
      caughtUp(await list());
      outer.moveReloaded();
      late();
    }
    else if (!replaying) settle(ended, answered_);
    try { outer.renderTabs(); renderChats(new Set(r.body.events.map(ev => ev.conversation))); } catch (e) { console.error('chat paint', e); }
  }
}
  return { noLoad, ART, keepBox, focus, show, stopChat, newSession, applyMode, setMode, modeShown, pickRemoteFolder, usageRows, cacheOf, busy, renderChats, paint, turnEnd, reply, dataNote, linkOk, history, loadChat, keepPlace, sentImgs, takenBack };
}
