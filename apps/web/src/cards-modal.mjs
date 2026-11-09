// Tabs, cards, pets and the modal. Split out of controller.mjs's mountShell (F9) with no change in behaviour; names that stay in mountShell come in through outer.
import { esc, svg } from './helpers.mjs';

export function installCards(outer) {
const centerCount = () => outer.cardList(true).filter(c => c.quiet || outer.S.snoozed.has(c.key)).length + outer.S.alerts.length;
const PET_ROLES = ['system', 'claude', 'codex'];
const DEFAULT_PET ={ on: true, size: 48, claude: null, codex: null, system: null, top: null, pane: null };
async function petLook(name) {
  const pet = await window.p9.loadPet(name).catch(() => null), img = new Image();
  if (pet) { img.src = pet.sprite; await img.decode().catch(() => {}); }
  if (img.naturalWidth < 1536) return null;
  const cv = new OffscreenCanvas(img.naturalWidth, img.naturalHeight), g = cv.getContext('2d'); g.drawImage(img, 0, 0);
  const frames = row => { let n = 0; while (n < 8 && g.getImageData(n * 192, row * 208, 192, 208).data.some((v, i) => i % 4 === 3 && v)) n++; return n || 1; };
  return { img, displayName: pet.displayName, rows: Array.from({ length: 9 }, (_, row) => frames(row)) };
}
async function loadPetLook() {
  if (!window.p9?.loadPet) return;
  for (const name of new Set(Object.values(outer.settings.pet).flatMap(f => [f.claude, f.codex, f.system]).filter(Boolean))) if (!outer.IND.looks.has(name)) outer.IND.looks.set(name, await petLook(name));
  renderIndicator();
}
// The top-bar pet ignores the on switch (Builder, 2026-10-18: "No. Keep it on. I like it."); the switch is for chat pets.
const petOf = (f, agent, always) => { const name = (always || f.on) && (f[agent] || f.system); return name && outer.IND.looks.get(name) ? name : null; };
function renderIndicator() {
  const active = outer.S.sessions.filter(s => s.state === 'running' && s.pending || outer.busy(s)), waiting = active.filter(s => s.pending).length, working = active.length - waiting;
  const state = waiting ? 'waiting' : working ? 'working' : null, el = outer.$('#agentInd'), f = outer.settings.pet[outer.S.focus];
  // One pet per active agent, in the top bar where the text was, always 52 px (Builder, 2026-10-17): waving and jumping while
  // it waits on you, running while it works. With no pet the spinner and text show there; each chat's line sits above its box.
  outer.IND.top = [...new Set(active.map(s => s.agent))].map(agent => ({ name: petOf(f, agent, true), rows: active.some(s => s.agent === agent && s.pending) ? '3,4' : '7' })).filter(p => p.name);
  // With no agent active the system pet stands idle there: the top pet is always on (Builder, 2026-10-18: "Keep it on. I like it.").
  if (!state) outer.IND.top = [{ name: petOf(f, 'system', true), rows: '0' }].filter(p => p.name);
  el.hidden = !state && !outer.IND.top.length; el.dataset.state = state || '';
  outer.$('#indText').textContent = state === 'waiting' ? (waiting > 1 ? waiting + ' agents wait on you' : 'An agent waits on you') : state ? (working > 1 ? working + ' agents working…' : 'Working…') : '';
  outer.$('#indGlyph').hidden = !!outer.IND.top.length;
  el.title = outer.IND.top.map(p => outer.IND.looks.get(p.name).displayName).join(', ');
  el.toggleAttribute('data-pet', !!outer.IND.top.length);
  tickPets();
}
const petCanvas = (name, rows, size, drag = true) => `<canvas class="pet" data-pet-name="${esc(name)}" data-rows="${rows}" width="192" height="208" style="height:${size}px;width:${Math.round(size * 192 / 208)}px"${drag ? ' title="Drag to move"' : ''}></canvas>`;
// A chat's pet acts out its state: waiting on you, thinking (review row), working (running), failed after an error,
// a jump for 4 s when a turn ends, else idle. Rows: 0 idle, 3 wave, 4 jump, 5 failed, 6 waiting, 7 running, 8 review.
const petRows = s => { const last = s.events.at(-1); return s.pending ? '6' : outer.busy(s) ? (last?.t === 'thought' ? '8' : '7') : last?.t === 'error' ? '5' : Date.now() - (s.lastEnd || 0) < 4000 ? '4' : '0'; };
function drawPet(cv) {
  const look = outer.IND.looks.get(cv.dataset.petName); if (!look) return;
  const seq = cv.dataset.rows.split(',').flatMap(row => Array.from({ length: look.rows[row] }, (_, i) => [+row, i])), [row, i] = seq[(outer.IND.frame + (+cv.dataset.phase || 0)) % seq.length];
  const g = cv.getContext('2d'); g.clearRect(0, 0, 192, 208); g.drawImage(look.img, i * 192, row * 208, 192, 208, 0, 0, 192, 208);
}
// ponytail: one 125 ms timer redraws every pet and re-finds the chat panes (they are re-rendered often); fine for a few pets.
function tickPets() {
  const f = outer.settings.pet[outer.S.focus], top = outer.$('#indPets'), key = outer.IND.top.map(p => p.name + ':' + p.rows).join(), glyph = outer.IND.glyphs[outer.IND.frame % outer.IND.glyphs.length];
  if (!outer.$('#agentInd').hidden) outer.$('#indGlyph').textContent = glyph;
  document.querySelectorAll('.working .glyph').forEach(g => { g.textContent = glyph; });
  if (top.dataset.key !== key) { top.dataset.key = key; top.innerHTML = outer.IND.top.map(p => petCanvas(p.name, p.rows, 52, false)).join(''); }
  document.querySelectorAll('#chats .pane, #mdlBody .pane').forEach(p => {
    const s = outer.S.sessions.find(x => x.id === p.dataset.id), name = s && petOf(f, s.agent), rows = s ? petRows(s) : '';
    let cv = p.querySelector(':scope > canvas.pet');
    if (!name) return cv?.remove();
    if (!cv || cv.dataset.petName !== name || cv.dataset.rows !== rows || cv.style.height !== f.size + 'px') { cv?.remove(); p.insertAdjacentHTML('beforeend', petCanvas(name, rows, f.size)); cv = p.lastElementChild; }
    const key = p.parentElement.id + ':' + s.id, r = p.getBoundingClientRect(), b = petBox(p);
    if (!r.width || !b) { cv.style.left = '10%'; cv.style.top = '70%'; return; }
    // A spot saved before D2 was a share of the pane: kept where it is now, from the box.
    if (Array.isArray(outer.petSpots[key])) { outer.petSpots[key] = { box: [r.left + outer.petSpots[key][0] * r.width - b.left, r.top + outer.petSpots[key][1] * r.height - b.top].map(Math.round) }; localStorage.setItem('p9-pet-spots', JSON.stringify(outer.petSpots)); }
    const [x, y] = (outer.IND.drag?.key === key && outer.IND.drag.at || outer.petSpots[key])?.box || petHome(p, cv, r, b);
    cv.style.left = Math.min(r.width, Math.max(0, b.left - r.left + x)) + 'px'; cv.style.top = Math.min(r.height, Math.max(0, b.top - r.top + y)) + 'px';
  });
  document.querySelectorAll('canvas.pet').forEach(drawPet);
  petTicker();
}
const petsMoving = () => !!(outer.IND.top.length || !outer.$('#agentInd').hidden || document.querySelector('canvas.pet, .working .glyph'));
function petTicker() {
  if (outer.petTimer || !petsMoving()) return;
  outer.petTimer = window.setInterval(() => {
    if (!petsMoving()) { window.clearInterval(outer.petTimer); outer.petTimer = 0; return; }
    if (!document.hidden) { outer.IND.frame++; tickPets(); }
  }, 125);
}
// Each chat keeps its own pet spot, apart in Chat Focus and in its chat window (Builder, 2026-10-19: moving one pet moved
// both, and moving the robot head window's pet moved the chat's). Settings' per-focus pane spot is no longer read.
// ponytail: localStorage (petSpots, top of this section), last 200 dragged chats; move it into the settings file if spots should follow a profile copy.
// Until dragged, a chat's pet stands left of its message box, standing on the box's top edge (Builder, 2026-10-20: moved from
// the right side to where the owner dragged his); with no room there, just above the box's left end.
// D2 (Builder, 2026-10-28: "Make the pets position reletive to the chat box"): a spot is px from the message box's top-left
// corner, not a share of the pane, so a side panel, split view or the editor that moves the box moves the pet with it.
function petHome(p, cv, r, b) {
  const c = p.querySelector('.bottom .col')?.getBoundingClientRect(), w = cv.offsetWidth, h = cv.offsetHeight;
  if (!c) return [-w, -h / 2];
  const beside = c.left - r.left >= w + 16;
  return [(beside ? c.left - 8 - w / 2 : c.left + w / 2) - b.left, (beside ? b.top - h / 2 : c.top - h / 2 - 4) - b.top];
}
const petBox = p => p.querySelector('.composer')?.getBoundingClientRect();
// The x and the body of a card: from the card itself, or from the Dev Focus overlay (main passes the clicked card's key).
function cardAct(c, what) {
  if (!c) return;
  if (c.key === 'welcome') return what === 'x' ? outer.skipWelcome() : outer.welcome();
  if (what === 'x') { outer.S.snoozed.add(c.key); renderCards(); return; }
  // D10-6: a card reopens where you left it, unless that item is already handled
  const k = c.key.split(':')[0] + (c.id || ''), r = outer.S.resume[k]; openModal(r && !(k === 'asks' && !outer.S.sessions.find(s => s.id === r.id)?.pending) ? r : c.open, k);
}
// Dev Focus: the editor is a native view above this page, so the cards are drawn by their own overlay view (apps/desktop/cards-page.mjs).
// This page's own stack stays in the layout, hidden, so the overlay lands where the stack would be.
function cardsOverlay() {
  if (!window.p9?.cards) return;
  const cards = outer.cardList(), r = outer.$('#cards').getBoundingClientRect(), on = outer.S.focus === 'dev' && cards.length > 0 && !document.querySelector('dialog[open]') && r.width > 0;
  const items = cards.slice(0, 8).map(c => ({ key: c.key.slice(0, 300), title: String(c.title).slice(0, 200), sub: String(c.sub ?? '').slice(0, 300), ...(c.n ? { n: Math.min(Number(c.n) || 0, 99999) } : {}) }));
  const next = on ? { visible: true, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), items } : { visible: false }, json = JSON.stringify(next);
  if (json === outer.lastCards) return; // renderCards runs on every event; main hears only a change
  outer.lastCards = json; window.p9.cards(next).catch(() => { outer.lastCards = ''; });
}
function renderCards() {
  renderIndicator();
  const cards = outer.cardList();
  outer.morph(outer.$('#cards'), cards.map(c => `<article class="card${c.halo ? ' fx-halo' : ''}" data-key="${esc(c.key)}"><button class="open">${c.n ? `<span class="n">${esc(c.n)}</span>` : `<span class="dot" data-agent="${esc(c.agent)}" data-live></span>`}<span class="truncate">${esc(c.title)}</span><span class="sub truncate">${esc(c.sub)}</span></button><button class="x" title="Snooze to the Notification Center">${svg.x}</button></article>`).join(''));
  outer.$('#cards').querySelectorAll('.card').forEach((el, i) => {
    el.querySelector('.x').onclick = () => cardAct(cards[i], 'x');
    el.querySelector('.open').onclick = () => cardAct(cards[i], 'open');
  });
  cardsOverlay();
  const n = centerCount();
  outer.$('#rBell').innerHTML = svg.bell + `<b>${n || ''}</b>`;
  outer.$('#rBell').title = 'Notification Center' + (n ? ` (${n})` : '') + ' · Ctrl Shift N';
  if (outer.mdl.open && outer.S.modal?.kind === 'center') outer.renderModal();
  outer.missionLive();
}
const sizes = { chat: [760, 620], list: [520, 460], review: [720, 640], file: [760, 560], script: [680, 560], sprint: [760, 560] }; // defaults; your resize wins, per type
const groupOf = k => ({ chat: 'chat', review: 'review', inbox: 'review', file: 'file', script: 'script', sprint: 'sprint' })[k] || 'list';
// A chat opens at its newest message (Builder, 2026-10-17: it opened at the first); paint ran while the dialog was closed.
function openModal(m, card) { const seen = m.kind === 'chat' && outer.S.sessions.find(s => s.id === m.id && s.done); if (seen) seen.done = false; m.card = card || m.card || m.back?.card; if (m.card) outer.S.resume[m.card] = m; outer.S.modal = m; if (m.kind === 'chat') delete outer.view['mdlBody:' + m.id]; outer.renderModal();
  if (!outer.mdl.open && outer.S.modal) { outer.mdl.showModal(); raiseToasts(); if (m.kind === 'win') outer.$('#mdlBody').scrollTop = outer.winTop[m.id] || 0; } // a closed dialog ignores scrollTop
  if (m.kind === 'chat') outer.$('#mdlBody .hist')?.scrollTo({ top: 1e6, behavior: 'instant' });
  if (seen) renderCards(); }
function closeModal() { outer.S.modal = null; if (outer.mdl.open) outer.mdl.close(); }
// a click on the backdrop closes; a resize drag or text selection that ends outside the box does not
const outside = e => { const r = outer.mdl.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
// mock: a running session stops to ask you something (palette: Simulate an agent question)
function askNow(id = 's-codex-1') {
  const s = outer.S.sessions.find(x => x.id === id); if (!s || s.pending) return;
  s.pending = 'question'; s.events.push({ t: 'question', title: 'Which test runner?', fields: [{ kind: 'radio', label: 'Runner', options: ['node --test', 'vitest'] }] });
  outer.renderTabs(); outer.renderChats();
}
/* ---------- popups ---------- */
// System events pop up bottom right and fade after --toast-life; hovering holds them. The item
// stays in the Notification Center until it is dismissed there (a toast only for things already done).
// Copy buttons (Builder, 2026-10-17: Copy on doctor's output did nothing). The button says how it went: toasts sit under an open dialog.
function toast(a, done) {
  if (!done) outer.S.alerts.push(a);
  const el = document.createElement('button');
  el.className = 'toast' + (a.level === 'bad' ? ' bad fx-halo' : ''); el.innerHTML = `<span class="lvl" data-l="${esc(a.level)}"></span><span class="truncate">${esc(a.txt)}</span><span class="sub">${esc(a.kind)}${done ? '' : ' · open'}</span>`; outer.addHalos(el);
  // D1 (Builder, 2026-10-28: "if i click it, it goes away"): every toast opens its whole message, and where to start, in the panel.
  el.onclick = () => openModal({ kind: 'alert', a, done });
  el.addEventListener('animationend', e => { if (e.animationName === 'toast-out') el.remove(); });
  outer.$('#toasts').append(el); raiseToasts(); renderCards();
}
const raiseToasts = () => {
  const box = outer.$('#toasts'), into = outer.modals.filter(d => d.matches(':modal')).pop() ?? document.body;
  if (box.parentElement !== into) into.append(box);
  if (box.children.length && box.showPopover) { box.hidePopover(); box.showPopover(); }
};
  return { PET_ROLES, DEFAULT_PET, petLook, loadPetLook, renderIndicator, petCanvas, tickPets, petBox, cardAct, cardsOverlay, renderCards, sizes, groupOf, openModal, closeModal, outside, askNow, toast, raiseToasts };
}
