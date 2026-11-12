// N1: the left panel (the N1 spec and the approved mock, round 3 without tabs). One panel, two widths: full
// in Chat Focus; a 48 px strip when collapsed, in Dev and Mission, and in a window under 1000 px (where the panel button
// opens it over the chat). It is the only chat switcher: the top bar's tab row, History and the rail's robot heads are gone.
// The frame is static in shell.html; this module fills the list and the strip, and owns collapse, width, search, the row
// menu, drag onto a project, the strip's title card, Ctrl B and Ctrl Tab. State lives on the sessions (controller's S).
import { svg, esc, dragBar } from './helpers.mjs';
import { agentIcon } from './agent-icons.mjs';
import { installProjects } from './projects-view.mjs';

const ic = d => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
export const PANEL_ICONS = {
  panel: ic('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>'),
  more: ic('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  folder: ic('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  folderPlus: ic('<path d="M12 10v6M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  hand: ic('<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
  alert: ic('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>'),
};
const I = PANEL_ICONS;
export const LABEL = { running: 'Running', needs: 'Waiting on you', unread: 'Finished, not read yet', failed: 'Failed' };
// A chat's state for its row and its strip icon: waiting for an answer, failed, finished and unread, running (busy pulses), or none.
export const stateOf = (s, busy) => s.pending ? 'needs' : s.failed ? 'failed' : s.done && !busy ? 'unread' : s.state === 'running' ? 'running' : '';
// The strip (the collapsed sidebar): every chat that is not stopped, idle ones already read included, then every stopped chat
// whose result is not seen yet (unread or failed). The panel's ordered() then puts the open ones in opening order; the stopped
// ones stay most recent first. A stopped chat leaves it when it is opened (renderChats clears done and failed).
const when = s => s.used || s.created || 0, recent = (a, b) => when(b) - when(a);
export const stripChats = sessions => { const live = s => s.state !== 'stopped', ok = sessions.filter(s => !s.archived);
  return [...ok.filter(live).sort(recent), ...ok.filter(s => !live(s) && (s.done || s.failed)).sort(recent)]; };
// The list: the chats a message was sent in, and the ones still open (what the tab row and History showed together).
export const listedChats = sessions => sessions.filter(s => (s.sent || !s.hidden) && !s.archived).sort(recent);
// A7 Delegate: a chat an agent started (its parent) sits under that chat when both are in the rows given: { s, depth } per
// chat and, for a chat with more than three sub-agents, one { fold } row above them. They start folded; opened[id] is the
// user's own choice, all (a search) opens every one, and the chat on screen (cur) is never folded away. A sub-agent whose
// parent is not in the rows stays where it would be without one.
export const nested = (rows, opened = {}, cur = [], all = false) => { const ids = new Set(rows.map(s => s.id)), out = [];
  const put = (s, depth) => { out.push({ s, depth }); const k = depth < 8 ? rows.filter(c => c.parent === s.id && c.id !== s.id) : []; if (!k.length) return;
    const open = all || k.some(c => cur.includes(c.id)) || (opened[s.id] ?? k.length <= 3);
    if (k.length > 3 && !all) out.push({ fold: s.id, n: k.length, open, depth: depth + 1 });
    if (open) for (const c of k) put(c, depth + 1); };
  for (const s of rows) if (!s.parent || s.parent === s.id || !ids.has(s.parent)) put(s, 0);
  return out; };
// A chat's project is the id the daemon gives it, never its folder (spec). An id no longer in the list puts it in Chats.
export const projectOf = (s, projects) => (s.project && projects.find(p => p.id === s.project)) || null;
// Times: short and one width, so titles line up.
const fmt = t => { if (!t) return ''; const m = Math.floor((Date.now() - t) / 60000), D = 1440;
  return m < 1 ? 'now' : m < 60 ? m + 'm' : m < D ? Math.floor(m / 60) + 'h' : m < 7 * D ? Math.floor(m / D) + 'd' : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }); };

export function installPanel(o, { focus, stopChat, busy }) {
  const $ = s => document.querySelector(s), nav = $('#nav'), list = $('#navList'), strip = $('#rBots'), body = nav.parentElement;
  const key = (k, v) => { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  // open: the projects shown open; null until one is toggled, when every project is open.
  const P = { q: '', more: {}, subs: {}, open: (k => k ? new Set(JSON.parse(k)) : null)(localStorage.getItem('p9-panel-open')), collapsed: localStorage.getItem('p9-panel-collapsed') === '1',
    w: Math.min(420, Math.max(220, Number(localStorage.getItem('p9-panel-w')) || 272)), narrow: false, overlay: false, moved: null, noclick: false };
  const projects = () => (o.S.projects || []).filter(p => !p.archived);
  const find = id => o.S.sessions.find(s => s.id === id);
  const shown = () => o.S.focus === 'chat' ? o.S.open.slice(0, o.S.split ? 2 : 1) : [];
  const live = s => s.state === 'running' || !!s.pending;
  const working = s => s.state !== 'stopped';
  const savedOrder = (() => { try { const value = JSON.parse(localStorage.getItem('p9-panel-open-order') || '[]'); return Array.isArray(value) ? value.filter(x => Array.isArray(x) && typeof x[0] === 'string' && Number.isSafeInteger(x[1]?.order)) : []; } catch { return []; } })();
  const positions = new Map(savedOrder); let nextPosition = Math.max(-1, ...savedOrder.map(([, value]) => value.order)) + 1;
  const ordered = sessions => {
    for (const s of [...sessions].sort((a, b) => when(a) - when(b))) {
      const active = working(s), before = positions.get(s.id);
      if (active && (!before || !before.active || before.project !== s.project)) positions.set(s.id, { active, project: s.project, order: nextPosition++ });
      else if (!active) positions.set(s.id, { active, project: s.project });
    }
    return [...sessions].sort((a, b) => Number(working(b)) - Number(working(a)) || (working(a) ? positions.get(a.id).order - positions.get(b.id).order : recent(a, b)));
  };
  // Two chats with one title (two new chats of one agent both read "Claude") get a number by age, as the old strip's #n did.
  const title = s => { const same = o.S.sessions.filter(x => x.title === s.title); return same.length > 1 && same[0] !== s ? s.title + ' ' + (same.indexOf(s) + 1) : s.title; };
  const stripped = () => P.collapsed || o.S.focus !== 'chat' || (P.narrow && !P.overlay);
  const hl = t => { const i = P.q ? t.toLowerCase().indexOf(P.q.toLowerCase()) : -1; return i < 0 ? esc(t) : esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + P.q.length)) + '</mark>' + esc(t.slice(i + P.q.length)); };
  const mark = (st, s) => st === 'running' ? `<span class="mk mk-run"${busy(s) ? ' data-busy' : ''} title="${busy(s) ? 'Working' : LABEL.running}"></span>`
    : st === 'needs' ? `<span class="mk mk-needs" title="${LABEL.needs}">${I.hand}</span>` : st === 'failed' ? `<span class="mk mk-failed" title="${LABEL.failed}">${svg.x}</span>`
    : st === 'unread' ? `<span class="mk mk-unread" title="${LABEL.unread}"></span>` : '';
  // Builder's build fix 1: a row's state mark takes the time's place; the time shows on hover and focus (panel.css).
  const chatRow = (s, depth = 0) => { const st = stateOf(s, busy(s)), cur = shown().includes(s.id), m = mark(st, s);
    return `<div class="rowwrap"${live(s) ? ' data-live' : ''}${depth ? ` data-depth="${Math.min(depth, 4)}"` : ''}><button class="row" data-chat="${esc(s.id)}" data-s="${st}" aria-current="${cur}" title="${esc(title(s))}${st ? ' · ' + LABEL[st] : ''}"${P.moved === s.id ? ' data-moved' : ''}><span class="dot" data-agent="${esc(s.agent)}"></span><span class="t">${hl(title(s))}</span><span class="tail"${m ? ' data-mark' : ''}>${m}<span class="when">${fmt(when(s))}</span></span></button>`
      + (live(s) ? `<button class="rstop" data-stop="${esc(s.id)}" title="Stop ${esc(o.names[s.agent] || s.agent)} in this chat" aria-label="Stop ${esc(title(s))}">${svg.stop}</button>` : '')
      + `<button class="more" data-more="${esc(s.id)}" aria-haspopup="menu" aria-expanded="false" title="More" aria-label="More for ${esc(title(s))}">${I.more}</button></div>`; };
  // A7: a zone's rows with each sub-agent under the chat that started it (nested, above).
  const tree = (rows, q) => nested(rows, P.subs, shown(), !!q);
  const treeRow = e => e.s ? chatRow(e.s, e.depth) : `<button class="row subs" data-subs="${esc(e.fold)}" data-depth="${Math.min(e.depth, 4)}" aria-expanded="${e.open}"><span class="chev">${svg.chev}</span><span class="t">${e.open ? 'Hide' : 'Show'} ${e.n} sub-agents</span></button>`;
  function renderList() {
    const q = P.q.toLowerCase(), hit = t => !q || String(t).toLowerCase().includes(q), all = ordered(listedChats(o.S.sessions)), ps = projects();
    const groups = ps.map(p => ({ p, kids: all.filter(s => s.project === p.id && (hit(s.title) || hit(p.name))) })).filter(g => hit(g.p.name) || g.kids.length);
    const general = all.filter(s => !projectOf(s, ps) && hit(s.title));
    // A search shows only the sections it matched; without one, Chats stays as the drop target that takes a chat out of a project.
    let h = q && !groups.length ? '' : `<div class="sh"><h3>Projects${ps.length ? ` <span class="n">${ps.length}</span>` : ''}</h3>${o.newProject ? `<button class="hadd" data-newproj title="New project" aria-label="New project">${svg.plus}</button>` : ''}</div>`;
    if (!ps.length && !q) h += `<div class="pempty"><p>Projects keep chats, instructions and files together.</p>${o.newProject ? `<button data-newproj>${I.folderPlus}New project</button>` : ''}</div>`;
    h += groups.map(({ p, kids }) => {
      // A search opens every project with a match, closed ones too (point 5). The count is the chats the row lists when
      // open (listedChats, as the New project offer), not the daemon's count, which takes in hidden and archived chats too.
      const open = isOpen(p.id) || !!q, ents = tree(kids, q), cut = !q && ents.length > 5, rows = cut && !P.more[p.id] ? ents.slice(0, 5) : ents, gone = p.found === false;
      return `<div data-zone="${esc(p.id)}"><div class="rowwrap"><button class="row proj" data-proj="${esc(p.id)}" aria-expanded="${open}" aria-current="${o.S.view?.kind === 'project' && o.S.view.id === p.id && o.S.focus === 'chat'}" title="${esc(p.name)}${gone ? ' · folder not found' : ''}"${gone ? ' data-missing' : ''}><span class="chev" data-toggle="${esc(p.id)}">${svg.chev}</span><span class="fold">${gone ? I.alert : I.folder}</span><span class="t">${hl(p.name)}</span><span class="n">${all.filter(s => s.project === p.id).length}</span></button>`
        + `<button class="padd" data-newin="${esc(p.id)}" title="New chat in ${esc(p.name)}" aria-label="New chat in ${esc(p.name)}">${svg.plus}</button></div>`
        + (open ? `<div class="kids">${rows.map(treeRow).join('')}${cut ? `<button class="row showmore" data-showmore="${esc(p.id)}">${P.more[p.id] ? 'Show fewer' : `Show ${ents.length - 5} more`}</button>` : ''}${kids.length ? '' : '<p class="none">No chats yet.</p>'}</div>` : '') + '</div>';
    }).join('');
    if (!q || general.length) h += `<div data-zone=""><div class="sh"><h3>Chats <span class="n">${general.length || ''}</span></h3></div>${tree(general, q).map(treeRow).join('')}</div>`;
    if (q && !groups.length && !general.length) h = `<p class="none">Nothing matches “${esc(P.q)}”.</p>`;
    // Archived projects and chats: one row at the end, to their page (projects-view.mjs), where Unarchive puts one back.
    const na = (o.S.projects || []).filter(p => p.archived).length + o.S.sessions.filter(s => s.archived && (s.sent || !s.hidden)).length;
    if (!q && na && o.openArchived) h += `<button class="row arch" data-archived aria-current="${o.S.view?.kind === 'archived' && o.S.focus === 'chat'}"><span class="t">Archived</span><span class="n">${na}</span></button>`;
    // Keep each existing row node with its chat when the order changes, including keyboard focus.
    const draft = document.createElement('template'); draft.innerHTML = h;
    for (const zone of draft.content.querySelectorAll('[data-zone]')) {
      const existing = [...list.querySelectorAll('[data-zone]')].find(x => x.dataset.zone === zone.dataset.zone);
      if (!existing) continue;
      const target = existing.querySelector('.kids') ?? existing;
      const source = zone.querySelector('.kids') ?? zone;
      const wanted = [...source.querySelectorAll(':scope > .rowwrap')].filter(x => x.querySelector('.row[data-chat]'));
      const old = new Map([...target.querySelectorAll(':scope > .rowwrap')].filter(x => x.querySelector('.row[data-chat]')).map(x => [x.querySelector('.row[data-chat]').dataset.chat, x]));
      const ids = new Set(wanted.map(x => x.querySelector('.row[data-chat]').dataset.chat));
      for (const [id, row] of old) if (!ids.has(id)) row.remove();
      let anchor = target.querySelector(':scope > .showmore, :scope > .none');
      for (const wantedRow of wanted.reverse()) {
        const id = wantedRow.querySelector('.row[data-chat]').dataset.chat, row = old.get(id) ?? wantedRow.cloneNode(true);
        if (row.nextSibling !== anchor || row.parentNode !== target) target.insertBefore(row, anchor);
        anchor = row;
      }
    }
    o.morph(list, h);
  }
  // Builder's build fix 2: the strip's marks are bigger than the mock's 12 px (panel.css .bm), so the hand and the cross read apart.
  function renderStrip() {
    const html = ordered(stripChats(o.S.sessions)).map(s => { const st = stateOf(s, busy(s));
      return `<button class="bot" data-chat="${esc(s.id)}" data-agent="${esc(s.agent)}" data-s="${st}"${busy(s) ? ' data-busy' : ''} aria-label="${esc(title(s))} · ${LABEL[st] || 'Idle'}" aria-current="${shown().includes(s.id)}">${agentIcon(s.agent)}<span class="bm">${st === 'needs' ? I.hand : st === 'failed' ? svg.x : ''}</span></button>`; }).join('');
    const draft = document.createElement('template'); draft.innerHTML = html;
    const wanted = [...draft.content.children], old = new Map([...strip.children].map(node => [node.dataset.chat, node]));
    const ids = new Set(wanted.map(node => node.dataset.chat));
    for (const [id, node] of old) if (!ids.has(id)) node.remove();
    let anchor = null;
    for (const next of wanted.reverse()) {
      const node = old.get(next.dataset.chat) ?? next.cloneNode(true);
      if (node.nextSibling !== anchor || node.parentNode !== strip) strip.insertBefore(node, anchor);
      anchor = node;
    }
    o.morph(strip, html);
  }
  function renderPanel() {
    const known = new Set(o.S.sessions.map(s => s.id));
    if (o.liveChat.on) for (const id of positions.keys()) if (!known.has(id)) positions.delete(id);
    ordered(o.S.sessions);
    if (o.liveChat.on) try { localStorage.setItem('p9-panel-open-order', JSON.stringify([...positions].filter(([, value]) => value.active))); } catch {}
    const shut = stripped();
    nav.toggleAttribute('data-collapsed', shut);
    nav.toggleAttribute('data-overlay', P.narrow && P.overlay && o.S.focus === 'chat');
    body.toggleAttribute('data-narrow', P.narrow);
    nav.style.setProperty('--pw', P.w + 'px');
    const col = $('#collapse');
    col.hidden = o.S.focus !== 'chat'; // in Dev and Mission the strip stays: there is nothing to expand there
    col.title = P.narrow ? (shut ? 'Open the panel over the chat (Ctrl B)' : 'Close the panel (Ctrl B)') : (shut ? 'Expand the panel (Ctrl B)' : 'Collapse the panel (Ctrl B)');
    col.setAttribute('aria-label', col.title.replace(/ \(.*/, '')); col.setAttribute('aria-pressed', String(shut));
    nav.toggleAttribute('data-nochat', !document.querySelector('#chats > .pane')); // the foot's terminal button stands in for the pane's
    if (!shut) renderList();
    renderStrip();
    if (P.moved) setTimeout(() => { P.moved = null; });
    o.renderPage?.(); // the project page or the chats (projects-view.mjs)
  }
  const setCollapsed = v => { P.collapsed = v; key('p9-panel-collapsed', v ? '1' : undefined); renderPanel(); o.placeDev?.(); };
  const toggle = () => { if (P.narrow) { P.overlay = !P.overlay; renderPanel(); } else setCollapsed(!P.collapsed); };
  const isOpen = id => !P.open || P.open.has(id);
  const setOpen = (id, v) => { P.open ??= new Set(projects().map(p => p.id)); v ? P.open.add(id) : P.open.delete(id); key('p9-panel-open', JSON.stringify([...P.open])); };
  // A click on a chat (row or strip) shows it in Chat Focus; with Chat Focus off in Settings, it opens as a card.
  const openChat = id => { closeMenu(); P.overlay = false; tip.hidden = true;
    if (o.S.focus !== 'chat' && !o.focusOn('chat')) return o.openModal({ kind: 'chat', id });
    if (o.S.view) o.S.view = null; const pj = find(id)?.project; if (pj && !isOpen(pj)) setOpen(pj, true); // the chat shown is never hidden in a closed project
    if (o.S.focus !== 'chat') o.setFocus('chat'); focus(id); };

  // ---- Row menu: Stop first on a live chat, then Move to project and Remove from project. ----
  let menuAnchor = null;
  function closeMenu(back) { document.querySelector('.lp-menu')?.remove(); menuAnchor?.setAttribute('aria-expanded', 'false'); if (back) menuAnchor?.focus(); menuAnchor = null; }
  function openMenu(html, at, anchor) {
    closeMenu();
    const m = document.createElement('div'); m.className = 'lp-menu'; m.setAttribute('role', 'menu'); m.innerHTML = html; document.body.append(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(at.x, innerWidth - r.width - 8)) + 'px'; m.style.top = Math.max(8, Math.min(at.y, innerHeight - r.height - 8)) + 'px';
    menuAnchor = anchor; anchor?.setAttribute('aria-expanded', 'true');
    m.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  function chatMenu(id, at, anchor) {
    const s = find(id); if (!s) return;
    const ps = projects(), cur = projectOf(s, ps), extra = o.chatMenuItems?.(s) || '';
    openMenu((live(s) ? `<button role="menuitem" data-stop="${esc(id)}">${svg.stop}Stop</button>` : '')
      + (ps.length ? `${live(s) ? '<div class="sep"></div>' : ''}<div class="lbl">Move to project</div>` + ps.map(p => `<button role="menuitemradio" aria-checked="${cur?.id === p.id}" data-moveto="${esc(p.id)}" data-id="${esc(id)}" ${cur?.id === p.id ? 'disabled' : ''}>${I.folder}<span>${esc(p.name)}</span>${cur?.id === p.id ? `<span class="mck">${svg.check}</span>` : ''}</button>`).join('') : '')
      + (cur ? `<div class="sep"></div><button role="menuitem" data-moveto="" data-id="${esc(id)}">${svg.x}Remove from project</button>` : '')
      + extra
      + (ps.length ? `<div class="note">It reads a project's instructions and files from its next message; its folder and files stay where they are. You can also drag a chat onto a project.</div>` : '')
      || '<div class="note">No projects yet.</div>', at, anchor);
  }

  // ---- Move to a project, with Undo. The daemon's 'project' event says the same to every window. ----
  async function move(id, to, undo) {
    const s = find(id), from = s?.project || null; to = to || null; closeMenu();
    if (!s || from === to) return;
    if (o.liveChat.on) { const r = await o.liveChat.call('moveChat', { id, project: to }); if (r.status !== 200) return; }
    s.project = to; P.moved = id; if (to) setOpen(to, true);
    o.renderTabs(); o.renderChats();
    if (undo) return;
    const name = id => esc(projects().find(p => p.id === id)?.name || 'the project');
    undoToast(to ? `Moved to <b>${name(to)}</b>` : `Removed from <b>${name(from)}</b>`, () => move(id, from, true));
  }
  let toastT = 0;
  function undoToast(html, undo) {
    document.querySelector('.lp-toast')?.remove(); clearTimeout(toastT);
    const t = document.createElement('div'); t.className = 'lp-toast'; t.setAttribute('role', 'status');
    t.innerHTML = `<span>${html}</span><button data-slot="button" data-variant="ghost" data-size="sm">Undo</button>`;
    t.querySelector('button').onclick = () => { t.remove(); undo(); };
    document.body.append(t); toastT = setTimeout(() => t.remove(), 6000);
  }

  // ---- Drag a chat row onto a project, or onto Chats (pointer events: the same on touch, and it shows in screenshots). ----
  let drag = null;
  list.addEventListener('pointerdown', e => { const r = e.target.closest('.row[data-chat]'); if (r && e.button === 0) drag = { id: r.dataset.chat, x: e.clientX, y: e.clientY, on: false, row: r }; });
  addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.on = true; closeMenu(); document.body.classList.add('lp-dragging'); drag.row.setAttribute('data-dragging', '');
      const s = find(drag.id), g = document.createElement('div'); g.className = 'lp-ghost';
      g.innerHTML = `<span class="t"><span class="dot" data-agent="${esc(s.agent)}"></span>${esc(title(s))}</span><span class="to">Drop on a project</span>`;
      document.body.append(g); drag.ghost = g;
    }
    drag.ghost.style.left = e.clientX + 'px'; drag.ghost.style.top = e.clientY + 'px';
    const z = document.elementFromPoint(e.clientX, e.clientY)?.closest('#navList [data-zone]'), to = z?.dataset.zone, s = find(drag.id);
    document.querySelectorAll('#navList [data-drop]').forEach(x => x.removeAttribute('data-drop'));
    drag.to = to !== undefined && to !== (projectOf(s, projects())?.id || '') ? to : undefined;
    if (drag.to !== undefined) (drag.to ? z.querySelector('.row.proj') : z.querySelector('h3')).setAttribute('data-drop', '');
    drag.ghost.querySelector('.to').innerHTML = drag.to === undefined ? 'Drop on a project' : `Move to <b>${esc(drag.to ? projects().find(p => p.id === drag.to)?.name : 'Chats')}</b>`;
  }, { signal: o.lifetime.signal });
  const endDrag = () => {
    const d = drag; drag = null; if (!d?.on) return;
    d.ghost.remove(); document.body.classList.remove('lp-dragging');
    document.querySelectorAll('#navList [data-drop], #navList [data-dragging]').forEach(x => { x.removeAttribute('data-drop'); x.removeAttribute('data-dragging'); });
    P.noclick = true; setTimeout(() => { P.noclick = false; }); // the click that ends a drag does not also open the chat
    if (d.to !== undefined) move(d.id, d.to);
  };
  addEventListener('pointerup', endDrag, { signal: o.lifetime.signal });
  addEventListener('pointercancel', endDrag, { signal: o.lifetime.signal });

  // ---- The strip's title card: on hover and on keyboard focus. Pointer first; otherwise the focused icon keeps its card. ----
  const tip = document.createElement('div'); tip.className = 'lp-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true; document.body.append(tip);
  const onStrip = el => el?.closest?.('#rBots .bot');
  const tipFor = e => {
    const b = (e.type !== 'focusout' && e.type !== 'pointerout' && onStrip(e.target)) || onStrip(document.activeElement), s = b && find(b.dataset.chat);
    if (!s) { tip.hidden = true; return; }
    const r = b.getBoundingClientRect(), st = stateOf(s, busy(s));
    tip.innerHTML = `<b>${esc(title(s))}</b><span>${esc(o.names[s.agent] || s.agent)} · ${esc(projectOf(s, projects())?.name || 'Chats')} · ${LABEL[st] || 'Idle'}</span>`;
    tip.style.left = r.right + 8 + 'px'; tip.style.top = r.top + r.height / 2 + 'px'; tip.hidden = false;
  };
  for (const ev of ['pointerover', 'pointerout', 'focusin', 'focusout']) strip.addEventListener(ev, e => setTimeout(() => tipFor(e)));

  // ---- Clicks, the menu's keys, search ----
  let pressedStop = null;
  nav.addEventListener('pointerdown', e => { pressedStop = e.target.closest?.('[data-stop]')?.dataset.stop ?? null; });
  nav.addEventListener('click', e => {
    if (P.noclick) return;
    const t = e.target;
    const st = t.closest('[data-stop]'); if (st) { const id = st.dataset.stop; if (e.detail && pressedStop !== id) return; pressedStop = null; const s = find(id); return s && stopChat(s); }
    const more = t.closest('[data-more]');
    if (more) { if (more.getAttribute('aria-expanded') === 'true') return closeMenu(); const r = more.getBoundingClientRect(); return chatMenu(more.dataset.more, { x: r.right - 230, y: r.bottom + 4 }, more); }
    const sub = t.closest('[data-subs]'); if (sub) { P.subs[sub.dataset.subs] = sub.getAttribute('aria-expanded') !== 'true'; return renderPanel(); }
    const sm = t.closest('[data-showmore]'); if (sm) { P.more[sm.dataset.showmore] = !P.more[sm.dataset.showmore]; return renderPanel(); }
    const tog = t.closest('[data-toggle]'), pr = t.closest('[data-proj]');
    if (tog || (pr && !o.openProject)) { const id = (tog || pr).dataset.toggle || pr.dataset.proj; setOpen(id, !isOpen(id)); return renderPanel(); }
    if (pr) { P.overlay = false; return o.openProject(pr.dataset.proj); }
    const ni = t.closest('[data-newin]'); if (ni) return o.newSession(o.lastAgent(), '', ni.dataset.newin);
    if (t.closest('[data-newproj]')) return o.newProject?.();
    if (t.closest('[data-archived]')) { P.overlay = false; return o.openArchived(); }
    const c = t.closest('[data-chat]'); if (c) return openChat(c.dataset.chat);
    if (t.closest('#collapse')) return toggle();
    if (t.closest('#stripSearch')) return o.openPal();
  });
  nav.addEventListener('contextmenu', e => { const r = e.target.closest('#navList .row[data-chat]'); if (!r) return; e.preventDefault(); chatMenu(r.dataset.chat, { x: e.clientX, y: e.clientY }, r.parentNode.querySelector('.more')); });
  addEventListener('click', e => {
    const m = e.target.closest?.('.lp-menu');
    if (m) { const st = e.target.closest('[data-stop]'), mv = e.target.closest('[data-moveto]'); if (st) { closeMenu(); const s = find(st.dataset.stop); if (s) stopChat(s); } else if (mv) move(mv.dataset.id, mv.dataset.moveto); return; }
    if (!e.target.closest?.('[data-more]')) closeMenu();
    if (P.overlay && !e.target.closest?.('#nav, .lp-toast')) { P.overlay = false; renderPanel(); } // the panel over the chat closes on a click outside it
  }, { signal: o.lifetime.signal });
  addEventListener('keydown', e => {
    const m = document.querySelector('.lp-menu');
    if (m && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); const b = [...m.querySelectorAll('button:not(:disabled)')], i = b.indexOf(document.activeElement); b[(i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length]?.focus(); return; }
    if (e.key === 'Escape') { if (m) { closeMenu(true); return; } if (P.overlay) { P.overlay = false; renderPanel(); } }
    if (m && e.key === 'Tab') closeMenu();
    // Ctrl B collapses (the terminal and the editor keep their own Ctrl B: tmux's prefix, bold).
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && o.S.focus === 'chat' && !e.target.closest?.('#dock, #devMain, .xterm, [contenteditable]')) { e.preventDefault(); toggle(); }
    // Ctrl Tab flips to the chat shown before this one (S.open keeps the last two, newest first).
    if (e.ctrlKey && e.key === 'Tab' && o.S.focus === 'chat' && o.S.open[1] && !e.target.closest?.('#dock')) { e.preventDefault(); openChat(o.S.open[1]); }
  }, { signal: o.lifetime.signal });
  $('#navQ').addEventListener('input', e => { P.q = e.target.value.trim(); renderPanel(); });
  $('#navQ').addEventListener('keydown', e => { if (e.key === 'Escape' && e.target.value) { e.stopPropagation(); e.target.value = ''; P.q = ''; renderPanel(); } });

  // ---- Width: drag or arrow keys on the grip, kept across restarts; narrow windows fold to the strip by themselves. ----
  dragBar(nav.querySelector('.p-grip'), { axis: 'x', get: () => P.w, set: px => { P.w = px; nav.style.setProperty('--pw', px + 'px'); }, min: 220, max: 420,
    done: px => key('p9-panel-w', String(Math.round(px))), signal: o.lifetime.signal });
  const mq = matchMedia('(max-width: 1000px)');
  const onWidth = () => { P.narrow = mq.matches; P.overlay = false; renderPanel(); };
  mq.addEventListener('change', onWidth, { signal: o.lifetime.signal });
  P.narrow = mq.matches;
  $('#collapse').innerHTML = I.panel; $('#stripSearch').innerHTML = svg.search;

  // Ctrl K: every chat and project, as palette rows ([label, run, icon, hint]); with nothing typed, the 5 latest chats.
  const jumps = q => {
    const ps = projects(), chats = listedChats(o.S.sessions).filter(s => !q || s.title.toLowerCase().includes(q));
    return [...(q ? ps.filter(p => p.name.toLowerCase().includes(q)) : []).map(p => [p.name, () => { setOpen(p.id, true); o.openProject ? o.openProject(p.id) : (o.setFocus('chat'), renderPanel()); }, I.folder, 'Project']),
      ...(q ? chats.slice(0, 20) : chats.slice(0, 5)).map(s => [title(s), () => openChat(s.id), `<span class="dot" data-agent="${esc(s.agent)}"></span>`, (projectOf(s, ps)?.name || 'Chats') + ' · ' + fmt(when(s))])];
  };
  // The projects list (GET /projects through p9:chat). Read at launch and after an event that changes a project's chats;
  // an older daemon without the route leaves the list empty.
  let loading = null;
  const loadProjects = () => !o.liveChat.on ? null : loading ||= (async () => { try { const r = await o.liveChat.call('projects', {}, { quiet: true });
    if (r.status === 200) { o.S.projects = r.body.projects; o.renderTabs(); o.renderChats(); } } finally { loading = null; } })();
  // The project's name in a chat's header: its page once there is one (o.openProject); until then its group in the panel.
  addEventListener('click', e => { const b = e.target.closest?.('[data-goproj]'); if (!b) return; const id = b.dataset.goproj;
    if (o.openProject) return o.openProject(id);
    setOpen(id, true); if (P.collapsed) setCollapsed(false); else if (P.narrow) P.overlay = true; renderPanel(); list.querySelector(`[data-proj="${CSS.escape(id)}"]`)?.focus(); }, { signal: o.lifetime.signal });
  const api = { renderPanel, jumps, openChat, move, setOpen, loadProjects, closeMenu, openMenu, undoToast, panel: P };
  installProjects(o, api); // N1 points 9 and 10: the project page, New project, a chat's Rename, Archive and Delete
  return api;
}
