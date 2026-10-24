import { popover as createPopover, svg, esc, limitLine, md } from './helpers.mjs';
// A choice is [value, label]; the sample data gives plain strings.
const opt = o => Array.isArray(o) ? o : [o, o];
import { DUWOP, shareLook } from './theme-picker';
import { applyLook, onLookChange } from './lib/theme';
import { WALKTHROUGH } from './walkthrough.mjs';
import { createSky } from './landing-sky.mjs';

export function mountShell() {
// The sample data lives in the test folder and never ships (the owner, 2026-10-20: "sample data should not be in the app at all").
// Only the UI tests hand it in, through the desktop bridge (P9_SAMPLE_DATA, unpackaged only). Everywhere else the lists start
// empty and fill from the daemon (GitHub issue #4: a fresh Windows install showed the sample items, and so did a dead daemon).
const sampleView = !!window.p9?.sample;
const M = sampleView ? structuredClone(window.p9.sample) : { sessions: [], history: [], files: [], fileBody: {}, queue: [], notifications: [], inbox: [],
  audit: { run: 'none yet', ticked: 0, total: 0, contradictions: 0 }, logs: { host: '', incidents: [], rows: [] }, solo: { when: 'none yet', txt: '' },
  stats: [['Work in flight (HANDOFF.md)', 0], ['Ideas not researched', 0], ['Punch-list items', 0]], apps: [], tools: [], pages: [], scripts: {}, terminal: [], outputs: {}, space: [] };
const lifetime = new AbortController(), timers = new Set(), observers = [];
const addEventListener = (type, listener) => window.addEventListener(type, listener, { signal: lifetime.signal });
const removeEventListener = (type, listener) => window.removeEventListener(type, listener);
const setTimeout = (fn, delay) => { const id = window.setTimeout(() => { timers.delete(id); fn(); }, delay); timers.add(id); return id; };
const observe = fn => { const observer = new ResizeObserver(fn); observers.push(observer); return observer; };
const popover = (...args) => createPopover(args[0], args[1], args[2], lifetime.signal);
DUWOP.init(); shareLook(lifetime.signal);

const $ = s => document.querySelector(s);
// Blink fix (Builder, 2026-10-17: "everything on the page blinks every few seconds"): each event re-rendered the cards and the
// Mission panels, restarting every halo. paint writes only when the HTML changed; callers still re-wire their handlers.
const written = new WeakMap();
// Brings el's children in line with html without rebuilding them (Builder, 2026-10-18: "the flashing is still there": every
// event rebuilt the panes, tabs and cards, restarting halos, blinks and thumbnails). Nodes are matched by position; kept
// ones keep their animations, decoded images and scroll. Form values follow the new markup, as a rebuild did. Pets
// (canvas.pet, added by tickPets) are left in place.
function morph(el, html) { const t = document.createElement('template'); t.innerHTML = html; sync(el, t.content); return el; }
function sync(a, b) {
  const olds = [...a.childNodes].filter(n => !(n.nodeType === 1 && n.matches('canvas.pet'))), news = [...b.childNodes];
  news.forEach((n, i) => {
    const o = olds[i];
    if (!o) return a.appendChild(n);
    if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) return a.replaceChild(n, o);
    if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; return; }
    attrs(o, n);
    if (o.tagName !== 'TEXTAREA') sync(o, n); // rewriting a textarea's text resets its caret
    // read from the markup: a template's own .value is not filled in
    const v = o.tagName === 'TEXTAREA' ? n.defaultValue : o.tagName === 'INPUT' && !['checkbox', 'radio', 'file'].includes(o.type) ? n.getAttribute('value') ?? '' : null;
    if (v !== null) { if (o.value !== v) o.value = v; }
    else if (o.tagName === 'INPUT') o.checked = n.hasAttribute('checked');
    else if (o.tagName === 'SELECT') o.selectedIndex = Math.max(0, [...n.options].findIndex(x => x.defaultSelected));
  });
  olds.slice(news.length).forEach(n => n.remove());
}
function attrs(o, n) {
  for (const { name } of [...o.attributes]) if (!n.hasAttribute(name)) o.removeAttribute(name);
  for (const { name, value } of [...n.attributes]) if (o.getAttribute(name) !== value) o.setAttribute(name, value);
}
const setHTML = (el, html) => { if (written.get(el) !== html) { written.set(el, html); el.innerHTML = html; } return el; };
// note 7: every chat starts in Auto mode
// Each agent's last model and command lists (daemon config / available_commands_update), so a new chat has them before its own session starts.
const lastModels = {}, lastCommands = {}, lastPickers = {};
// Live chats list the agent's own models; the sample data keeps its two names.
function modelOpts(s) {
  const m = s.models || lastModels[s.agent];
  if (!s.live || !m) return `<option>${esc(s.model)}</option><option>${s.agent === 'codex' ? 'gpt-5.1-codex-mini' : 'Sonnet 5.5'}</option>`;
  const pick = s.modelPick || m.current;
  return m.options.map(o => `<option value="${esc(o.value)}"${o.value === pick ? ' selected' : ''}>${esc(o.name)}</option>`).join('');
}
// Live chats show the agent's own Effort, Fast mode and (Codex) plan switch (threat model row 22); the sample data keeps its Effort.
function pickerSelects(s) {
  const list = s.pickers || lastPickers[s.agent];
  if (!s.live || !list) return `<select data-slot="select" aria-label="Effort"><option>${esc(s.effort)}</option><option>High</option><option>Low</option></select>`;
  return list.map(p => { const pick = s.pick?.[p.id] ?? p.current;
    return `<select data-slot="select" aria-label="${esc(p.name)}" data-pick="${esc(p.id)}">${p.options.map(o => `<option value="${esc(o.value)}"${o.value === pick ? ' selected' : ''}>${esc(p.name)}: ${esc(o.name)}</option>`).join('')}</select>`; }).join('');
}
// Each agent's own mode names (the daemon's allowlist, chat.mjs MODES). Threat model row 25: a new chat starts in the last mode
// picked for its agent on this computer (at first Claude Auto, Codex Auto review); the two loosened modes ask first, in red.
const modes = { claude: ['Auto', 'Manual', 'Plan', 'Accept edits', 'Bypass permissions'], codex: ['Read-only', 'Workspace access', 'Auto review', 'Full access'] };
const LOOSE = { 'Bypass permissions': 'Claude runs every command and edits any file it can reach, without asking first.',
  'Full access': 'Codex runs without a sandbox: it can read and change any file on this computer and use the network, without asking first.' };
const startMode = agent => { const m = localStorage.getItem('p9-mode:' + agent); return modes[agent].includes(m) ? m : agent === 'codex' ? 'Auto review' : 'Auto'; };
const looseOk = (agent, m) => new Promise(done => {
  const d = $('#looseDlg'); $('#looseT').textContent = `Turn on ${m} for ${names[agent]}?`; $('#looseP').textContent = LOOSE[m]; d.returnValue = '';
  d.onclose = () => { if (d.returnValue === 'never') localStorage.setItem('p9-mode-ok:' + m, '1'); done(d.returnValue === 'yes' || d.returnValue === 'never'); };
  d.showModal();
});
const S = { sessions: structuredClone(M.sessions).map(s => ({ ...s, mode: startMode(s.agent), queue: [] })), open: sampleView ? ['s-claude-1','s-codex-1'] : [], split: false, files: false,
  focus: 'chat', termOpen: { chat: false, dev: false, mission: false }, termMode: { chat: 'float', dev: 'drawer', mission: 'float' },
  snoozed: new Set(), quiet: new Set(), setup: null, reviews: structuredClone(M.queue), alerts: [], modal: null, resume: {},
  docs: {}, dev: { tabs: [], active: null } };
const names = { claude: 'Claude', codex: 'Codex' };
const focusNames = { chat: 'Chat Focus', dev: 'Dev Focus', mission: 'Mission Control' };
/* icons */
const ic = d => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
Object.assign(svg, {
  chat: ic('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>'),
  code: ic('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/><path d="m14.5 4-5 16"/>'),
  gauge: ic('<path d="m12 14 4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>'),
  clock: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  bell: ic('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'),
  bot: ic('<path d="M12 4v3"/><circle cx="12" cy="3" r="1"/><rect x="4" y="7" width="16" height="13" rx="3"/><circle cx="9" cy="13" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.4" fill="currentColor" stroke="none"/><path d="M9.5 17h5M2 12v3M22 12v3"/>'),
});
for (const [id, k] of [['rChat','chat'],['rDev','code'],['rMission','gauge'],['rBell','bell'],['newBtn','plus'],['stopAll','stop'],['rSearch','search'],['rFiles','files'],['rSplit','split'],['rTerm','term'],['rCmd','cmd'],['themeBtn','palette'],['setBtn','gear'],['dFloat','float'],['dHide','x']]) $('#'+id).innerHTML = svg[k];

/* ---------- tabs ---------- */
function renderTabs() {
  morph($('#tabs'), S.sessions.filter(s => !s.hidden).map(s => `<button class="tab" role="tab" data-id="${esc(s.id)}" data-state="${esc(s.state)}" aria-selected="${S.open.slice(0, S.split ? 2 : 1).includes(s.id)}"><span class="dot" data-agent="${esc(s.agent)}"></span><span>${esc(s.title)}</span>${s.pending ? '<span class="attn" title="Needs you"></span>' : ''}<span class="close" title="Close tab">${svg.x}</span></button>`).join(''));
  $('#tabs').querySelectorAll('.tab').forEach(t => {
    t.onclick = e => { if (e.target.closest('.close')) { closeTab(t.dataset.id); return; } focus(t.dataset.id); };
  });
  $('#runCount').textContent = S.sessions.filter(s => s.state === 'running').length + ' running';
  renderCards();
}
/* ---------- cards ---------- */
// What needs you or is running out of sight. Same stack in every focus. The x snoozes a card:
// it leaves the stack and waits in the Notification Center (bell) until its items change.
function cardList(all) {
  const asks = S.sessions.filter(s => s.pending);
  const cards = [];
  if (asks.length) cards.push({ key: 'asks:' + asks.map(s => s.id + s.pending).join(), halo: true, n: asks.length, title: asks.length === 1 ? names[asks[0].agent] + ' needs you' : asks.length + ' agents need you', sub: asks.map(s => s.title).join(' · '), open: asks.length === 1 ? { kind: 'chat', id: asks[0].id } : { kind: 'asks' } });
  // Only _tyler/ items that arrive while the app is open get a card (Builder, 2026-10-17); the ones already there, and the ones
  // he skips, wait quietly in the Notification Center. Running chats are robot heads in the rail (renderBots).
  const fresh = S.reviews.filter(r => !S.quiet.has(r.file)), old = S.reviews.length - fresh.length;
  if (fresh.length) cards.push({ key: 'reviews:' + fresh.map(r => r.file).join(), halo: true, n: fresh.length, title: fresh.length === 1 ? '1 item needs you' : fresh.length + ' items need you', sub: (live.waiting || 'waiting') + '/ · ' + fresh[0].proj, open: fresh.length === 1 ? { kind: 'review', i: S.reviews.indexOf(fresh[0]) } : { kind: 'reviews' } });
  if (old) cards.push({ key: 'waiting', quiet: true, n: old, title: (old === 1 ? '1 item' : old + ' items') + ' in ' + (live.waiting || 'waiting') + '/' /* the user's own folder name (settings.waiting) */, sub: 'waiting', open: { kind: 'reviews' } });
  for (const s of S.sessions.filter(x => x.done)) cards.push({ key: 'done:' + s.id, id: s.id, halo: true, agent: s.agent, title: names[s.agent] + ' finished', sub: s.title, open: { kind: 'chat', id: s.id } });
  if (S.setup) { const d = setupDone(S.setup), left = Object.keys(d).filter(k => !d[k]); cards.push({ key: 'welcome', quiet: welSkipped(), n: left.length, title: `Set up · ${4 - left.length} of 4 done`, sub: left.map(k => STEP_NAMES[k]).join(' · ') }); }
  return all ? cards : cards.filter(c => !c.quiet && !S.snoozed.has(c.key));
}
const centerCount = () => cardList(true).filter(c => c.quiet || S.snoozed.has(c.key)).length + S.alerts.length;
/* ---------- agent-working indicator and pets (phase 18; Builder's pet requests, 2026-10-17) ---------- */
// The top bar says when agents work or wait on you, in every focus, with Claude Code's spinner. Where a focus shows pets
// (Settings, one set per focus), each active agent's pet takes that text's place (see renderIndicator) and every chat on
// screen holds its agent's pet (petRows). A chat's pet drags anywhere in it; the spot is kept per focus. A sheet is 8 x 9 frames of
// 192 x 208: row 0 idle, 3 wave, 4 jump, 6 waiting, 7 running; each row's frame count is read from the sheet.
const IND = { glyphs: '·✢✳✶✻✽✻✶✳✢', looks: new Map(), frame: 0, top: [], drag: null };
const PET_ROLES = ['system', 'claude', 'codex'];
const petSpots = JSON.parse(localStorage.getItem('p9-pet-spots') || '{}'); // 'chats:<id>' or 'mdlBody:<id>' -> [x, y], see petHome
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
  for (const name of new Set(Object.values(settings.pet).flatMap(f => [f.claude, f.codex, f.system]).filter(Boolean))) if (!IND.looks.has(name)) IND.looks.set(name, await petLook(name));
  renderIndicator();
}
// The top-bar pet ignores the on switch (Builder, 2026-10-18: "No. Keep it on. I like it."); the switch is for chat pets.
const petOf = (f, agent, always) => { const name = (always || f.on) && (f[agent] || f.system); return name && IND.looks.get(name) ? name : null; };
function renderIndicator() {
  const active = S.sessions.filter(s => s.state === 'running' && s.pending || busy(s)), waiting = active.filter(s => s.pending).length, working = active.length - waiting;
  const state = waiting ? 'waiting' : working ? 'working' : null, el = $('#agentInd'), f = settings.pet[S.focus];
  // One pet per active agent, in the top bar where the text was, always 52 px (Builder, 2026-10-17): waving and jumping while
  // it waits on you, running while it works. With no pet the spinner and text show there; each chat's line sits above its box.
  IND.top = [...new Set(active.map(s => s.agent))].map(agent => ({ name: petOf(f, agent, true), rows: active.some(s => s.agent === agent && s.pending) ? '3,4' : '7' })).filter(p => p.name);
  // With no agent active the system pet stands idle there: the top pet is always on (Builder, 2026-10-18: "Keep it on. I like it.").
  if (!state) IND.top = [{ name: petOf(f, 'system', true), rows: '0' }].filter(p => p.name);
  el.hidden = !state && !IND.top.length; el.dataset.state = state || '';
  $('#indText').textContent = state === 'waiting' ? (waiting > 1 ? waiting + ' agents wait on you' : 'An agent waits on you') : state ? (working > 1 ? working + ' agents working…' : 'Working…') : '';
  $('#indGlyph').hidden = !!IND.top.length;
  el.title = IND.top.map(p => IND.looks.get(p.name).displayName).join(', ');
  el.toggleAttribute('data-pet', !!IND.top.length);
  tickPets();
}
const petCanvas = (name, rows, size, drag = true) => `<canvas class="pet" data-pet-name="${esc(name)}" data-rows="${rows}" width="192" height="208" style="height:${size}px;width:${Math.round(size * 192 / 208)}px"${drag ? ' title="Drag to move"' : ''}></canvas>`;
// A chat's pet acts out its state: waiting on you, thinking (review row), working (running), failed after an error,
// a jump for 4 s when a turn ends, else idle. Rows: 0 idle, 3 wave, 4 jump, 5 failed, 6 waiting, 7 running, 8 review.
const petRows = s => { const last = s.events.at(-1); return s.pending ? '6' : busy(s) ? (last?.t === 'thought' ? '8' : '7') : last?.t === 'error' ? '5' : Date.now() - (s.lastEnd || 0) < 4000 ? '4' : '0'; };
function drawPet(cv) {
  const look = IND.looks.get(cv.dataset.petName); if (!look) return;
  const seq = cv.dataset.rows.split(',').flatMap(row => Array.from({ length: look.rows[row] }, (_, i) => [+row, i])), [row, i] = seq[(IND.frame + (+cv.dataset.phase || 0)) % seq.length];
  const g = cv.getContext('2d'); g.clearRect(0, 0, 192, 208); g.drawImage(look.img, i * 192, row * 208, 192, 208, 0, 0, 192, 208);
}
// ponytail: one 125 ms timer redraws every pet and re-finds the chat panes (they are re-rendered often); fine for a few pets.
function tickPets() {
  const f = settings.pet[S.focus], top = $('#indPets'), key = IND.top.map(p => p.name + ':' + p.rows).join(), glyph = IND.glyphs[IND.frame % IND.glyphs.length];
  if (!$('#agentInd').hidden) $('#indGlyph').textContent = glyph;
  document.querySelectorAll('.working .glyph').forEach(g => { g.textContent = glyph; });
  if (top.dataset.key !== key) { top.dataset.key = key; top.innerHTML = IND.top.map(p => petCanvas(p.name, p.rows, 52, false)).join(''); }
  document.querySelectorAll('#chats .pane, #mdlBody .pane').forEach(p => {
    const s = S.sessions.find(x => x.id === p.dataset.id), name = s && petOf(f, s.agent), rows = s ? petRows(s) : '';
    let cv = p.querySelector(':scope > canvas.pet');
    if (!name) return cv?.remove();
    if (!cv || cv.dataset.petName !== name || cv.dataset.rows !== rows || cv.style.height !== f.size + 'px') { cv?.remove(); p.insertAdjacentHTML('beforeend', petCanvas(name, rows, f.size)); cv = p.lastElementChild; }
    const key = p.parentElement.id + ':' + s.id, at = IND.drag?.key === key && IND.drag.at || petSpots[key] || petHome(p, cv);
    cv.style.left = at[0] * 100 + '%'; cv.style.top = at[1] * 100 + '%';
  });
  document.querySelectorAll('canvas.pet').forEach(drawPet);
}
setInterval(() => { if (!document.hidden) { IND.frame++; tickPets(); } }, 125);
// Each chat keeps its own pet spot, apart in Chat Focus and in its chat window (Builder, 2026-10-19: moving one pet moved
// both, and moving the robot head window's pet moved the chat's). Settings' per-focus pane spot is no longer read.
// ponytail: localStorage (petSpots, top of this section), last 200 dragged chats; move it into the settings file if spots should follow a profile copy.
// Until dragged, a chat's pet stands left of its message box, standing on the box's top edge (Builder, 2026-10-20: moved from
// the right side to where the owner dragged his); with no room there, just above the box's left end.
function petHome(p, cv) {
  const r = p.getBoundingClientRect(), c = p.querySelector('.bottom .col')?.getBoundingClientRect(), b = p.querySelector('.composer')?.getBoundingClientRect(), w = cv.offsetWidth, h = cv.offsetHeight;
  if (!r.width || !r.height || !c || !b) return [0.1, 0.7];
  const beside = c.left - r.left >= w + 16;
  return [((beside ? c.left - 8 - w / 2 : c.left + w / 2) - r.left) / r.width, ((beside ? b.top - h / 2 : c.top - h / 2 - 4) - r.top) / r.height];
}
// Drag a chat's pet within its chat; the spot is saved for that chat on release. The top bar's pets stay put.
document.addEventListener('pointerdown', e => {
  const cv = e.target.closest?.('.pane canvas.pet'); if (!cv || e.button) return;
  e.preventDefault();
  const pane = cv.closest('.pane'), where = `#${pane.parentElement.id} .pane[data-id="${CSS.escape(pane.dataset.id)}"]`;
  IND.drag = { key: pane.parentElement.id + ':' + pane.dataset.id, at: null };
  const move = ev => {
    const r = document.querySelector(where)?.getBoundingClientRect(); if (!r) return;
    IND.drag.at = [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height].map(n => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000);
    tickPets();
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    const { key, at } = IND.drag; IND.drag = null;
    if (!at) return;
    delete petSpots[key]; petSpots[key] = at; // newest last, so the trim drops the oldest
    for (const k of Object.keys(petSpots).slice(0, -200)) delete petSpots[k];
    localStorage.setItem('p9-pet-spots', JSON.stringify(petSpots));
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});
// Running chats not waiting on you, as robot heads in the rail (Builder, 2026-10-17); a click opens the chat. Waiting ones stay cards.
function renderBots() {
  const bots = S.sessions.filter(s => s.state === 'running' && !s.pending), say = s => names[s.agent] + ' · ' + (busy(s) ? 'working' : 'idle');
  setHTML($('#rBots'), bots.map(s => `<button data-slot="button" data-variant="ghost" data-size="icon" class="bot" data-bot="${esc(s.id)}" data-agent="${esc(s.agent)}"${busy(s) ? ' data-busy' : ''} title="${esc(s.title)} · ${esc(say(s))}" aria-label="${esc(s.title)} · ${esc(say(s))}">${svg.bot}</button>`).join(''));
  $('#rBots').querySelectorAll('[data-bot]').forEach(b => b.onclick = () => { const k = 'run' + b.dataset.bot; openModal(S.resume[k] || { kind: 'chat', id: b.dataset.bot }, k); });
}
function renderCards() {
  renderIndicator(); renderBots();
  const cards = cardList();
  morph($('#cards'), cards.map(c => `<article class="card${c.halo ? ' fx-halo' : ''}" data-key="${esc(c.key)}"><button class="open">${c.n ? `<span class="n">${esc(c.n)}</span>` : `<span class="dot" data-agent="${esc(c.agent)}" data-live></span>`}<span class="truncate">${esc(c.title)}</span><span class="sub truncate">${esc(c.sub)}</span></button><button class="x" title="Snooze to the Notification Center">${svg.x}</button></article>`).join(''));
  $('#cards').querySelectorAll('.card').forEach((el, i) => {
    const c = cards[i];
    if (c.key === 'welcome') { el.querySelector('.x').onclick = skipWelcome; el.querySelector('.open').onclick = () => welcome(); return; }
    el.querySelector('.x').onclick = () => { S.snoozed.add(c.key); renderCards(); };
    // D10-6: a card reopens where you left it, unless that item is already handled
    el.querySelector('.open').onclick = () => { const k = c.key.split(':')[0] + (c.id || ''), r = S.resume[k]; openModal(r && !(k === 'asks' && !S.sessions.find(s => s.id === r.id)?.pending) ? r : c.open, k); };
  });
  const n = centerCount();
  $('#rBell').innerHTML = svg.bell + `<b>${n || ''}</b>`;
  $('#rBell').title = 'Notification Center' + (n ? ` (${n})` : '') + ' · Ctrl Shift N';
  if (mdl.open && S.modal?.kind === 'center') renderModal();
  missionLive();
}

/* ---------- modals ---------- */
// One resizable dialog for every item. Its content is rebuilt from S on each open, so closing loses
// nothing: drafts live on the session or item, S.resume remembers the card view, and list scroll is kept.
// Closing puts the caret back in the field you were typing in before the card took you away.
const mdl = $('#mdl');
const sizes = { chat: [760, 620], list: [520, 460], review: [720, 640], file: [760, 560], script: [680, 560] }; // defaults; your resize wins, per type
const groupOf = k => ({ chat: 'chat', review: 'review', inbox: 'review', file: 'file', script: 'script' })[k] || 'list';
let lastEdit = null;
addEventListener('focusout', e => { const t = e.target; if (t.matches?.('textarea, input[type=text]') && !t.closest('dialog')) lastEdit = { pane: t.closest('.pane')?.dataset.id, id: t.id, sel: [t.selectionStart, t.selectionEnd] }; });
addEventListener('focusin', e => { if (!e.target.closest('dialog, .cards, .toasts, .rail') && !e.target.matches('textarea, input[type=text]')) lastEdit = null; });
// A chat opens at its newest message (Builder, 2026-10-17: it opened at the first); paint ran while the dialog was closed.
function openModal(m, card) { const seen = m.kind === 'chat' && S.sessions.find(s => s.id === m.id && s.done); if (seen) seen.done = false; m.card = card || m.card || m.back?.card; if (m.card) S.resume[m.card] = m; S.modal = m; if (m.kind === 'chat') delete view['mdlBody:' + m.id]; renderModal();
  if (!mdl.open && S.modal) { mdl.showModal(); if (m.kind === 'win') $('#mdlBody').scrollTop = winTop[m.id] || 0; } // a closed dialog ignores scrollTop
  if (m.kind === 'chat') $('#mdlBody .hist')?.scrollTo({ top: 1e6, behavior: 'instant' });
  if (seen) renderCards(); }
function renderModal() {
  const m = S.modal, body = $('#mdlBody'), g = groupOf(m.kind);
  if (mdl.dataset.group !== g) {
    let wh = sizes[g]; try { wh = JSON.parse(localStorage.getItem('eh-modal:' + g)) || wh; } catch {}
    mdl.style.width = wh[0] + 'px'; mdl.style.height = wh[1] + 'px'; mdl.dataset.group = g;
  }
  const key = m.kind === 'win' ? 'win:' + m.id : m.kind;
  const top = m.kind === 'win' ? winTop[m.id] || 0 : body.dataset.kind === key ? body.scrollTop : 0;
  body.onscroll = null; body.dataset.kind = key; $('#mdlFoot').innerHTML = '';
  $('#mdlBack').hidden = !m.back; $('#mdlPrimary').hidden = m.kind !== 'chat' && m.kind !== 'file' || m.live;
  const row = (i, a, b, c) => `<li><button data-i="${esc(i)}">${a}<span class="truncate">${b}</span><span class="sub truncate">${c}</span></button></li>`;
  if (m.kind === 'chat') {
    const s = S.sessions.find(x => x.id === m.id); if (!s) return closeModal();
    $('#mdlT').textContent = s.title; paint(body, [s]);
  } else if (m.kind === 'file' && m.live) {
    // A real file from the Chat Focus browser, read-only (threat model row 23).
    $('#mdlT').textContent = m.name;
    if (m.text === undefined && !m.loading) { m.loading = true; window.p9.mission('read', { path: m.name }).then(r => { m.text = r.status === 200 ? r.body.content : null; m.error = r.body?.error || String(r.status); if (S.modal === m) renderModal(); }); }
    body.innerHTML = m.text === undefined ? '<p class="sm muted">Loading…</p>' : m.text === null ? `<p class="sm muted">Not readable: ${esc(m.error)}</p>` : `<pre class="fileview">${esc(m.text)}</pre>`;
    $('#mdlFoot').innerHTML = `<span class="muted sm mono truncate">${esc(m.name)}</span><span class="spacer"></span><span class="muted sm">Read-only · edit in Dev Focus</span>`;
  } else if (m.kind === 'file') {
    // D03: one file at a time, explicit Save; the draft lives in S.docs, so closing loses nothing
    const d = doc(m.name); $('#mdlT').textContent = m.name;
    body.innerHTML = editorHtml(m.name, 'mdlEd'); wireEditor(body, m.name, renderModalFoot);
    renderModalFoot();
  } else if (m.kind === 'asks') {
    const asks = S.sessions.filter(s => s.pending); if (!asks.length) return closeModal();
    $('#mdlT').textContent = asks.length + ' agents need you';
    body.innerHTML = `<ul class="mlist">${asks.map(s => row(s.id, `<span class="dot" data-agent="${esc(s.agent)}" data-live></span>`, esc(s.title), names[s.agent] + ' · ' + (s.pending === 'approval' ? 'wants approval' : 'asks a question'))).join('')}</ul>`;
    body.querySelectorAll('[data-i]').forEach(b => b.onclick = () => openModal({ kind: 'chat', id: b.dataset.i, back: m }));
  } else if (m.kind === 'reviews') {
    if (!S.reviews.length) return closeModal();
    $('#mdlT').textContent = S.reviews.length + ' items need you';
    body.innerHTML = `<ul class="mlist">${S.reviews.map((r, i) => row(i, `<span class="kind">${esc(r.kind)}</span>`, esc(r.txt), esc(r.proj) + ' · ' + esc(r.age) + (r.draft ? ' · draft' : ''))).join('')}</ul>`;
    body.querySelectorAll('[data-i]').forEach(b => b.onclick = () => openModal({ kind: 'review', i: +b.dataset.i, back: m }));
  } else if (m.kind === 'review') {
    // D10-3: Save & Continue handles this item and moves on; Skip leaves it pending in _tyler/, takes its card off the stack
    // (Builder, 2026-10-17: Skip never dismissed it) and moves on, closing after the last item
    if (!S.reviews.length) return closeModal();
    const i = m.i = Math.min(m.i, S.reviews.length - 1), r = S.reviews[i];
    $('#mdlT').textContent = `${i + 1} of ${S.reviews.length} · ${r.proj}`;
    body.innerHTML = `<div class="review"><span class="kind">${esc(r.kind)} · ${esc(r.age)}</span><p>${esc(r.txt)}</p><div class="fileview" aria-label="${esc(r.file)}"><span class="mono sm muted">${esc(r.file)}</span>${fileView(r.file)}</div><label>Your answer<textarea data-answer placeholder="Write your answer. It is kept if you close this.">${esc(r.draft || '')}</textarea></label></div>`;
    const ta = body.querySelector('textarea'); ta.oninput = () => { r.draft = ta.value; };
    if (r.sel) { ta.focus(); ta.setSelectionRange(...r.sel); }
    ta.onselect = ta.onkeyup = ta.onclick = () => { r.sel = [ta.selectionStart, ta.selectionEnd]; };
    $('#mdlFoot').innerHTML = `<span class="muted sm">Saved answers go to ${esc(r.file.split('/')[0])}/</span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-skip>Skip</button><button data-slot="button" data-save>Save &amp; Continue</button>`;
    $('#mdlFoot [data-skip]').onclick = () => { S.quiet.add(r.file); renderCards(); if (i + 1 < S.reviews.length) { m.i = i + 1; renderModal(); } else closeModal(); };
    $('#mdlFoot [data-save]').onclick = () => r.live ? answerLive(r) : (() => { S.reviews.splice(i, 1); toast({ kind: 'saved', txt: 'Answer saved to ' + r.file, level: 'ok' }, true); renderTabs(); if (S.reviews.length) { m.i = i % S.reviews.length; renderModal(); } else closeModal(); })();
  } else if (m.kind === 'center') {
    const snoozed = cardList(true).filter(c => c.quiet || S.snoozed.has(c.key));
    $('#mdlT').textContent = 'Notification Center';
    body.innerHTML = !snoozed.length && !S.alerts.length ? '<p class="empty">Nothing waiting on you.</p>'
      : `<ul class="mlist">${snoozed.map((c, i) => row('c' + i, c.n ? `<span class="n">${esc(c.n)}</span>` : `<span class="dot" data-agent="${esc(c.agent)}"></span>`, esc(c.title), (c.quiet ? '' : 'snoozed · ') + esc(c.sub))).join('')}${S.alerts.map((a, i) => row('a' + i, `<span class="lvl" data-l="${esc(a.level)}"></span>`, esc(a.txt), esc(a.kind))).join('')}</ul>`;
    body.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const k = b.dataset.i, c = snoozed[+k.slice(1)]; if (c?.key === 'welcome') { closeModal(); welcome(); } else if (k[0] === 'c') { S.snoozed.delete(c.key); renderCards(); openModal({ ...c.open, back: m }); } else openModal({ kind: 'alert', a: S.alerts[+k.slice(1)], back: m }); });
  } else if (m.kind === 'alert') {
    const a = m.a; $('#mdlT').textContent = a.kind;
    body.innerHTML = `<div class="review"><span class="kind"><span class="lvl" data-l="${esc(a.level)}"></span> ${esc(a.kind)}</span><p>${esc(a.txt)}</p><p class="muted sm">${a.hub ? 'From the scheduled-job and setup checks. Dismiss hides it until the next check still finds it.' : 'In the real app this opens the check\'s log in Mission Control.'}</p></div>`;
    $('#mdlFoot').innerHTML = `<span class="spacer"></span><button data-slot="button" data-variant="outline" data-dismiss>Dismiss</button>`;
    $('#mdlFoot [data-dismiss]').onclick = () => { S.alerts = S.alerts.filter(x => x !== a); if (H.notices) H.notices = H.notices.filter(x => x !== a); renderCards(); missionLive(); m.back ? openModal(m.back) : closeModal(); };
  } else missionModal(m, body, row);
  body.scrollTop = top;
}
function closeModal() { S.modal = null; if (mdl.open) mdl.close(); }
observe(() => { if (mdl.open && mdl.dataset.group) try { localStorage.setItem('eh-modal:' + mdl.dataset.group, JSON.stringify([mdl.offsetWidth, mdl.offsetHeight])); } catch {} }).observe(mdl);
$('#mdlX').onclick = closeModal;
$('#mdlBack').onclick = () => openModal(S.modal.back);
// a click on the backdrop closes; a resize drag or text selection that ends outside the box does not
const outside = e => { const r = mdl.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
let downOutside = false;
mdl.addEventListener('pointerdown', e => { downOutside = outside(e); });
mdl.addEventListener('click', e => { if (e.target === mdl && downOutside && outside(e)) closeModal(); });
mdl.addEventListener('close', () => {
  if (!mdl.open) S.modal = null;
  const r = lastEdit; renderTabs(); renderChats(); renderTree(); renderDev();
  if (S.primary) { const go = S.primary; S.primary = null; return go(); } // Make Primary: its own caret step runs after the re-render
  const t = r && (r.id ? document.getElementById(r.id) : $(`#chats .pane[data-id="${r.pane}"] textarea`));
  if (t && !t.closest('[inert]')) { t.focus(); t.setSelectionRange(...r.sel); }
});
// D05: Make Primary takes the chat out of the modal into Chat Focus, draft and all
$('#mdlPrimary').onclick = () => { if (S.modal.kind === 'file') return devPrimary(S.modal.name); const id = S.modal.id; S.primary = () => {}; closeModal(); setFocus('chat'); focus(id); const t = $(`#chats .pane[data-id="${id}"] textarea`); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } };
$('#rBell').onclick = () => openModal({ kind: 'center' });

// action buttons answer a click: green for 5 s (Builder, 2026-10-14)
// ponytail: a button whose footer re-renders on click (Run) is replaced, so only buttons that stay put show it
addEventListener('click', e => { const b = e.target.closest('#mdlFoot [data-slot="button"], .acts [data-slot="button"], .ebar [data-slot="button"]'); if (!b) return; b.classList.add('done'); clearTimeout(b._done); b._done = setTimeout(() => b.classList.remove('done'), 5000); });
// mock: a running session stops to ask you something (palette: Simulate an agent question)
function askNow(id = 's-codex-1') {
  const s = S.sessions.find(x => x.id === id); if (!s || s.pending) return;
  s.pending = 'question'; s.events.push({ t: 'question', title: 'Which test runner?', fields: [{ kind: 'radio', label: 'Runner', options: ['node --test', 'vitest'] }] });
  renderTabs(); renderChats();
}

/* ---------- popups ---------- */
// System events pop up bottom right and fade after --toast-life; hovering holds them. The item
// stays in the Notification Center until it is dismissed there (a toast only for things already done).
// Copy buttons (Builder, 2026-10-17: Copy on doctor's output did nothing). The button says how it went: toasts sit under an open dialog.
const copy = (text, btn) => navigator.clipboard.writeText(text).then(() => 'Copied', e => { btn.title = String(e?.message || e); return 'Copy failed'; }).then(said => { const was = btn.textContent; btn.textContent = said; btn.dataset.said = said; setTimeout(() => { btn.textContent = was; delete btn.dataset.said; }, 2000); });
function toast(a, done) {
  if (!done) S.alerts.push(a);
  const el = document.createElement('button');
  el.className = 'toast' + (a.level === 'bad' ? ' bad fx-halo' : ''); el.innerHTML = `<span class="lvl" data-l="${esc(a.level)}"></span><span class="truncate">${esc(a.txt)}</span><span class="sub">${esc(a.kind)}${done ? '' : ' · open'}</span>`;
  el.onclick = () => { el.remove(); if (!done) openModal({ kind: 'alert', a }); };
  el.addEventListener('animationend', e => { if (e.animationName === 'toast-out') el.remove(); });
  $('#toasts').append(el); renderCards();
}
function focus(id) { const s = S.sessions.find(x => x.id === id); if (s?.hidden) { s.hidden = false; closedChats.delete(id); keepClosed(); } show(id); renderTabs(); renderChats(); }
// The chat shown goes first and the one before it second, so Split has the last two (Builder, 2026-10-19: replacing only
// the first kept a one-tab start at one open chat, and Split showed one pane).
const show = id => { S.open = [id, ...S.open.filter(x => x !== id)].slice(0, 2); if (S.files) renderTree(); }; // Current project files follow the chat shown
// Tabs (Builder, 2026-10-17: 30 sessions opened on every load): a live chat gets a tab while it is not stopped and not
// closed by you; the rest wait in History. Closed IDs stay in localStorage so a reload does not bring them back.
const closedChats = new Set(JSON.parse(localStorage.getItem('eh-closed-chats') || '[]'));
const keepClosed = () => localStorage.setItem('eh-closed-chats', JSON.stringify([...closedChats]));
// Hide steps (Builder, 2026-10-18: "where is the button to hide the commands and thinking output?"): one switch for every chat, kept across restarts.
let hideSteps = localStorage.getItem('p9-hide-steps') === '1';
function closeTab(id) {
  const s = S.sessions.find(x => x.id === id);
  if (s) s.done = false; // closing it is seeing it
  // The x stops a running chat, like closing a VS Code terminal tab (Builder, 2026-10-18); History reopens it.
  if (s?.live) { if (s.state === 'running') liveChat.stop(s); s.hidden = true; closedChats.add(id); keepClosed(); } else S.sessions = S.sessions.filter(x => x.id !== id);
  S.open = S.open.map(o => o === id ? (S.sessions.find(x => !x.hidden && !S.open.includes(x.id)) || {}).id : o).filter(Boolean); renderTabs(); renderChats();
}
function newSession(agent, model) {
  if (liveChat.on) return liveChat.create(agent, newFolder);
  const s = { id: 's-' + Date.now(), agent, title: `${names[agent]} ${S.sessions.filter(x => x.agent === agent).length + 1}`, model, mode: startMode(agent), queue: [], effort: 'Medium', state: 'idle', pending: null, context: null, limits: M.sessions[agent === 'claude' ? 0 : 1].limits, cacheMin: null, cwd: M.sessions[0].cwd, events: [] };
  S.sessions.push(s); show(s.id); renderTabs(); renderChats();
}
$('#newPop').innerHTML = `<div class="hd eyebrow">Start in</div><select data-slot="select" aria-label="Start in" id="newFolder" style="margin:0 9px 6px;width:calc(100% - 18px)"></select><hr data-slot="separator" style="margin:6px 0"><div class="hd eyebrow">New Claude</div><button class="item" data-new="claude" data-model="Opus 5.5">Claude <span class="muted">default model</span></button><button class="item" data-new="claude" data-model="Sonnet 5.5">Claude · Sonnet 5.5</button><button class="item" data-new="claude" data-model="Haiku 5.5">Claude · Haiku 5.5</button><hr data-slot="separator" style="margin:6px 0"><div class="hd eyebrow">New Codex</div><button class="item" data-new="codex" data-model="gpt-5.1-codex">Codex <span class="muted">default model</span></button><button class="item" data-new="codex" data-model="gpt-5.1-codex-mini">Codex · mini</button>`;
// New chat's folder (Builder, 2026-10-19: "a dropdown with what folder i want to open the chat in"; threat model row 24): the workspace,
// the main project, the last 5 folders used, or the system folder dialog (main sends back only a folder inside the workspace;
// ':pick' cannot be a folder, the daemon refuses ':' in paths).
// The daemon checks it again. The choice stays picked until changed.
let newFolder = '';
const recentFolders = () => { try { const r = JSON.parse(localStorage.getItem('eh-chat-folders')); return Array.isArray(r) ? r.filter(f => typeof f === 'string').slice(0, 5) : []; } catch { return []; } };
function renderNewFolder() {
  const seen = new Set(), opts = [['', 'Workspace'], ...(live.primary ? [[live.primary.path, 'Main project · ' + live.primary.name]] : []), ...[newFolder, ...recentFolders()].map(f => [f, f])]
    .filter(([v]) => !seen.has(v) && seen.add(v));
  $('#newFolder').innerHTML = opts.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('') + (window.p9?.pickFolder ? '<option value=":pick">Choose folder…</option>' : '');
  $('#newFolder').value = newFolder;
}
$('#newFolder').onchange = async e => {
  if (e.target.value !== ':pick') { newFolder = e.target.value; return; }
  const picked = await window.p9.pickFolder();
  if (typeof picked === 'string') newFolder = picked;
  else if (picked === null) toast({ kind: 'chat', txt: 'Pick a folder inside the workspace.', level: 'warn' }, true);
  renderNewFolder();
};
const newPop = popover($('#newBtn'), $('#newPop'), renderNewFolder);
$('#newPop').querySelectorAll('[data-new]').forEach(b => b.onclick = () => { newSession(b.dataset.new, b.dataset.model); newPop.close(); });
// History: with the daemon, every live chat, newest first (Open gives it a tab again); without it, the sample list.
const when = at => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const liveHistory = () => S.sessions.slice().reverse().map(s => { const asks = s.events.filter(e => e.t === 'user'); return `<div class="item" style="cursor:default"><span class="dot" data-agent="${esc(s.agent)}"></span><div style="min-width:0"><div class="truncate">${esc(asks[0]?.text || s.title)}</div><div class="xs muted">${names[s.agent]}${s.created ? ' · ' + esc(when(s.created)) : ''} · ${esc(s.state)}${s.stub ? '' : ` · ${asks.length} message${asks.length === 1 ? '' : 's'}`}${s.hidden ? '' : ' · in a tab'}</div></div><button data-slot="button" data-variant="outline" data-size="sm" data-open="${esc(s.id)}" style="margin-left:auto">Open</button></div>`; }).join('') || '<p class="sm muted" style="margin:6px 9px">No chats yet.</p>';
const renderHistory = () => $('#histPop').innerHTML = `<p class="sm muted" style="margin:6px 9px 10px">Close the window or quit the UI and sessions keep running. History stays here; Resume continues the provider's native session.</p>` + (liveChat.on ? liveHistory() : M.history.map(h => `<div class="item" style="cursor:default"><span class="dot" data-agent="${esc(h.agent)}"></span><div style="min-width:0"><div class="truncate">${esc(h.title)}</div><div class="xs muted">${esc(h.when)} · ${esc(h.events)} events · ${esc(h.id)}</div></div><button data-slot="button" data-variant="outline" data-size="sm" data-open="${esc(h.id)}" style="margin-left:auto">Open</button></div>`).join(''));
const histPop = popover($('#histBtn'), $('#histPop'), renderHistory);
$('#histPop').onclick = e => { const b = e.target.closest('[data-open]'); if (!b) return; if (liveChat.on) { focus(b.dataset.open); histPop.close(); return; } const h = M.history.find(x => x.id === b.dataset.open); const s = { id: 'h-' + h.id, agent: h.agent, title: h.title, model: h.agent === 'claude' ? 'Opus 5.5' : 'gpt-5.1-codex', mode: 'Manual', queue: [], effort: 'Medium', state: 'stopped', readonly: true, pending: null, context: {used: 61000, size: 200000}, limits: M.sessions[0].limits, cacheMin: null, cwd: M.sessions[0].cwd, events: [{t:'notice', text:`Older events are not shown; this view holds the latest 2,000 of ${esc(h.events)}.`}, {t:'user', text:'Finish the Phase 9 fixes and rerun the suite.', when: h.when}, {t:'tool', status:'completed', title:'Shell: pnpm test', output:'ℹ tests 51\nℹ pass 51\nℹ fail 0'}, {t:'agent', text:'Suite green. The History popover now closes on Open and the narrow toolbar scrolls instead of clipping.'}] }; if (!S.sessions.find(x => x.id === s.id)) S.sessions.push(s); show(s.id); renderTabs(); renderChats(); histPop.close(); };
DUWOP.menu($('#themePop')); popover($('#themeBtn'), $('#themePop'));

/* ---------- chats ---------- */
const mdOf = e => { if (e.mdFor !== e.text) { e.md = md.parse(e.text); e.mdFor = e.text; } return e.md; };
// Live chats: context from the agent's usage_update, 5 h and 7 d from the daemon's /usage for this agent (a reading over
// an hour old is dimmed), the cache timed from the last turn end (Claude only: its prompt cache lasts an hour).
// One limit window as a bar (chat meters and Mission's Usage panel); an expired window shows a dash.
const meterBar = (label, w, line, now = Date.now()) => { const p = !w || w.resetsAt && w.resetsAt < now ? null : Math.round(w.usedPercent); return `<div class="meter" title="${esc(line.text)}"${line.stale ? ' data-stale' : ''}><div class="l"><span>${label}</span><b>${p == null ? '—' : p + '%'}</b></div><div class="fx-meter" ${p >= 80 ? 'data-hot' : ''}><span style="width:${p || 0}%"></span></div></div>`; };
function meters(s) {
  const ctx = s.context ? Math.round(s.context.used / s.context.size * 100) : null;
  const cacheMin = !s.live ? s.cacheMin : s.agent === 'claude' && s.lastEnd ? Math.floor((Date.now() - s.lastEnd) / 60000) : null;
  const left = cacheMin == null ? null : 60 - cacheMin;
  const lim = s.live ? usage.limits?.[s.agent] : { fiveHour: { usedPercent: s.limits.h5 * 100 }, sevenDay: { usedPercent: s.limits.d7 * 100 }, asOf: Date.now() };
  const line = limitLine(names[s.agent], lim), now = Date.now();
  const bar = (label, w) => meterBar(label, w, line, now);
  const cache = left == null ? ['—', ''] : left <= 0 ? ['cold', 'cold'] : [left + ' min', left < 20 ? 'cooling' : 'warm'];
  return `<div class="meters">
    <div class="meter" title="${esc(ctx == null ? 'No usage_update from this agent yet' : s.context.used.toLocaleString() + ' of ' + s.context.size.toLocaleString() + ' tokens')}"><div class="l"><span>Context</span><b>${ctx == null ? '—' : ctx + '%'}</b></div><div class="fx-meter" ${ctx >= 80 ? 'data-hot' : ''}><span style="width:${ctx || 0}%"></span></div></div>
    ${bar('5 h', lim?.fiveHour)}
    ${bar('7 d', lim?.sevenDay)}
    <div class="cache" data-s="${cache[1]}" title="1-hour prompt cache, timed from the last turn end">${svg.clock}${cache[0]}</div>
  </div>`;
}
function event(e, s) {
  switch (e.t) {
    case 'user': return `<div class="msg user"><div class="who">You${e.when ? ' · ' + esc(e.when) : ''}</div>${esc(e.text)}${e.images ? `<div class="xs muted" style="margin-top:6px">📎 ${esc(e.images)} image${e.images > 1 ? 's' : ''}</div>` : ''}</div>`;
    case 'agent': return `<div class="msg agent"><div class="who">${names[s.agent]}</div>${mdOf(e)}${agentImgs(e.images, names[s.agent])}</div>`;
    case 'thought': return `<details class="thought" data-ev="${s.events.lastIndexOf(e)}"${e.open ? ' open' : ''}><summary>Thinking</summary><p>${esc(e.text)}</p></details>`;
    case 'tool': return `<details class="tool" data-ev="${s.events.lastIndexOf(e)}"${(e.open ?? e.status === 'in_progress') ? ' open' : ''}><summary><span class="chev">${svg.chev}</span><span data-slot="badge" data-variant="${e.status === 'completed' ? 'ok' : e.status === 'failed' ? 'bad' : 'primary'}">${esc(e.status.replace('_',' '))}</span><span class="ttl truncate">${esc(e.title)}</span></summary>${e.diff ? diff(e.diff) : ''}${e.output ? `<pre>${esc(e.output)}</pre>` : e.status === 'in_progress' ? '<pre class="caret"></pre>' : ''}</details>${agentImgs(e.images, names[s.agent])}`;
    case 'plan': return `<div class="plan fx-title fx-lift"><div class="eyebrow">Plan</div><ul style="margin:0;padding:0">${e.entries.map(([st, t]) => `<li data-s="${esc(st)}"><span class="i">${st === 'completed' ? '✓' : st === 'in_progress' ? '▸' : '○'}</span><span>${esc(t)}</span></li>`).join('')}</ul></div>`;
    case 'notice': return `<div class="notice">${esc(e.text)}</div>`;
    case 'error': return `<div class="notice" style="color:var(--destructive)">${esc(e.text)}</div>`;
  }
  return '';
}
const diff = rows => `<div class="diff">${rows.map(([k, l]) => `<div class="${esc(k)}">${k === 'add' ? '+' : k === 'del' ? '−' : ' '} ${esc(l)}</div>`).join('')}</div>`;
function pending(s) {
  if (s.pending === 'approval') { const a = s.events.find(e => e.t === 'approval'); return `<div class="pending fx-halo" role="group" aria-label="Approval"><div class="eyebrow">Approval needed</div><h4>${esc(a.title)}</h4>${diff(a.diff)}${s.live ? '<p class="hint">Sending a message declines this and sends the message instead.</p>' : ''}<div class="acts">${a.options.map(([k, l, kind]) => `<button data-slot="button" data-variant="${(kind || k).startsWith('reject') ? 'outline' : 'default'}" data-size="sm" class="fx-lift" data-approve="${esc(k)}">${esc(l)}</button>`).join('')}</div></div>`; }
  if (s.pending === 'question') { const q = s.events.find(e => e.t === 'question'); return `<form class="pending fx-halo" data-question><div class="eyebrow">${names[s.agent]} asks</div><h4>${esc(q.title)}</h4>${q.unsupported ? '<p class="hint">P9 cannot show this form faithfully. Decline, or answer in a message.</p>' : ''}${s.live ? '<p class="hint">Sending a message declines this question and sends the message instead.</p>' : ''}${q.fields.map((f, i) => { const head = `<span>${esc(f.label)}${f.required ? ' *' : ''}</span>${f.hint ? `<small>${esc(f.hint)}</small>` : ''}`; return f.kind === 'radio' ? `<div class="field">${head}${f.options.map(opt).map(([v, l]) => `<label><input type="radio" name="f${i}" value="${esc(v)}" ${(q.vals?.['f' + i] ?? ('def' in f ? f.def : opt(f.options[0])[0])) === v ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>`
    : f.kind === 'multi' ? `<div class="field">${head}${f.options.map(opt).map(([v, l], j) => `<label><input type="checkbox" name="f${i}~${j}" value="${esc(v)}" ${q.vals?.[`f${i}~${j}`] !== undefined ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>` : `<div class="field">${head}<input data-slot="input" name="f${i}" value="${esc(q.vals?.['f' + i] || '')}"></div>`; }).join('')}<div class="acts">${q.unsupported ? '' : '<button data-slot="button" data-variant="default" data-size="sm" type="submit">Submit answer</button>'}<button data-slot="button" data-variant="outline" data-size="sm" type="button" data-decline>Decline</button></div></form>`; }
  return '';
}
// A turn is in flight while a tool runs or a reply streams; messages and mode changes queue behind it.
const busy = s => s.live ? s.state === 'running' && !s.pending && !!s.working : s.state === 'running' && !s.pending && (!!s.streaming || s.events.some(e => e.t === 'tool' && e.status === 'in_progress'));
// Only a chat's latest TAIL steps are drawn (Builder, 2026-10-20: the window lagged and froze; one redraw of a 25,000-event
// chat built 31 MB of HTML in about 170 ms, and live chats redraw on every batch). "Show earlier" adds TAIL more.
const TAIL = 200;
function shown(s) {
  const list = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'), from = Math.max(0, list.length - (s.tail || TAIL));
  return (from ? `<button data-slot="button" data-variant="ghost" data-size="sm" class="earlier" data-earlier>Show earlier (${from.toLocaleString()} more)</button>` : '')
    + list.slice(from).map(e => event(e, s)).join('');
}
function pane(s, i, bare) {
  const working = busy(s);
  const stateLabel = { running: 'Running', stopped: s.readonly ? 'Read-only · history' : 'Stopped', idle: 'Not started', stopping: 'Stopping…' }[s.state];
  const body = s.stub ? '<div class="welcome"><p>Loading this chat…</p></div>' : s.events.length === 0 ?`<div class="welcome"><span class="dot" data-agent="${esc(s.agent)}" data-live></span><h2 class="fx-title">What are we working on?</h2><p>${names[s.agent]} · ${esc(s.cwd)}</p><div class="chips"><span data-slot="badge">${esc(s.model)}</span><span data-slot="badge">${esc(s.mode)}</span></div>${s.live ? '<p data-start-hint>Type your first message below to start.</p>' : `<button data-slot="button" data-variant="secondary" style="margin-top:8px" data-start>Start ${names[s.agent]} chat</button>`}</div>`
    : `<div class="col">${shown(s)}${pending(s)}</div>`;
  const pick = s.modeNext || s.mode;
  return `<section class="pane${i === 0 && S.split ? ' focus' : ''}" data-id="${esc(s.id)}"${hideSteps ? ' data-quiet' : ''} aria-label="${names[s.agent]} chat">
    <div class="ptool"><span class="dot" data-agent="${esc(s.agent)}" ${s.state === 'running' ? 'data-live' : ''}></span><span class="name">${names[s.agent]}</span>
      <select data-slot="select" aria-label="Mode" data-mode>${modes[s.agent].map(m => `<option${m === pick ? ' selected' : ''}>${m}</option>`).join('')}</select>${s.modeNext ? `<span class="mode-q" title="Applies when this turn ends">queued</span>` : ''}
      <select data-slot="select" aria-label="Model" data-model>${modelOpts(s)}</select>
      ${pickerSelects(s)}
      <button data-slot="button" data-variant="ghost" data-size="sm" data-steps aria-pressed="${hideSteps}" title="Tool calls and thinking">${hideSteps ? 'Show steps' : 'Hide steps'}</button>
      <span class="state" data-s="${esc(s.state)}">${stateLabel}</span>
      ${s.state === 'running' ? `<button data-slot="button" data-variant="ghost" data-size="sm" data-stop>Stop</button>` : s.state === 'stopped' ? `<button data-slot="button" data-variant="outline" data-size="sm" data-resume>Resume</button>` : ''}
      ${bare ? '' : `<button data-slot="button" data-variant="ghost" data-size="icon-sm" title="Close" data-close>${svg.x}</button>`}</div>
    <div class="hist">${body}</div>
    <div class="bottom"><div class="col">${working ? `<div class="working"><span class="glyph" aria-hidden="true">${IND.glyphs[IND.frame % IND.glyphs.length]}</span>${names[s.agent]} is working…</div>` : ''}${s.readonly ? '' : meters(s)}
      ${s.queue.length ? `<div class="queue">${s.queue.map((q, j) => `<div class="q"><span>Queued: ${esc(q)}</span><button title="Interrupt and send this now" data-qnow="${j}">${svg.bolt}</button><button title="Remove from the queue" data-qdel="${j}">${svg.x}</button></div>`).join('')}</div>` : ''}
      <div class="composer"><div class="slash" data-slash hidden></div>${s.images?.length ? `<div class="attach">${s.images.map((im, i) => `<span class="att"><img src="data:${im.mimeType};base64,${im.data}" alt="${esc(im.name)}" title="${esc(im.name)}"><button data-unattach="${i}" title="Remove" aria-label="Remove ${esc(im.name)}">×</button></span>`).join('')}</div>` : ''}<textarea placeholder="${s.readonly ? 'Resume this conversation to send' : s.state === 'idle' ? 'Start a chat to send' : 'Message ' + names[s.agent] + '…'}" rows="2" ${s.readonly ? 'disabled' : ''}>${esc(s.draft || '')}</textarea><div class="bar"><span class="hint">${working ? 'Enter · queue  Ctrl Enter · interrupt and send' : 'Shift Enter · new line / for commands'}</span><span class="spacer"></span><button data-slot="button" data-variant="ghost" data-size="icon-sm" title="Attach image (max 4)" data-attach>${svg.clip}</button>${working ? `<button data-slot="button" data-variant="ghost" data-size="icon-sm" title="Stop this turn" data-cancel>${svg.stop}</button>` : ''}<button data-slot="button" data-size="icon-sm" class="send" title="${working ? 'Queue (Enter). Ctrl click interrupts and sends' : 'Send'}" data-send>${svg.send}</button></div></div></div></div>
  </section>`;
}
// Panes are rebuilt from S on every change (streaming replies re-render every 18 ms), so the
// state a person owns lives in S or is carried across: draft in s.draft, images in s.images,
// tool/thinking open state in the event, scroll + caret captured here. A pane at the bottom stays pinned to it.
const view = {}; // 'container:session id' -> { top, pinned, selection }
// only: the chat ids a daemon batch touched; the other panes shown are left as they are.
function renderChats(only) {
  const ids = S.split ? S.open.slice(0, 2) : S.open.slice(0, 1);
  const ss = ids.map(id => S.sessions.find(s => s.id === id)).filter(Boolean);
  if (document.hasFocus()) { const seen = [...(S.focus === 'chat' ? ss : []), mdl.open && S.modal?.kind === 'chat' && S.sessions.find(s => s.id === S.modal.id)].filter(s => s?.done); seen.forEach(s => { s.done = false; }); if (seen.length) renderCards(); }
  $('#chats').dataset.split = String(S.split && ss.length > 1);
  for (const s of [...ss, mdl.open && S.modal?.kind === 'chat' && S.sessions.find(x => x.id === S.modal.id)]) if (s?.stub) history(s);
  paint($('#chats'), ss, only);
  if (mdl.open && S.modal?.kind === 'chat') paint($('#mdlBody'), [S.sessions.find(s => s.id === S.modal.id)].filter(Boolean), only);
  tickPets(); // paint rebuilt the panes: put their pets back now, not on the next frame
}
// The same pane renders in Chat Focus and inside a chat modal; root says which.
// E2: with only, and the same panes still shown in the same order, just those panes are rebuilt and re-wired. Before,
// each daemon batch rebuilt every pane shown, so a quiet 200-step chat beside a streaming one cost the same each time.
function paint(root, ss, only) {
  const bare = root.id === 'mdlBody', old = [...root.querySelectorAll(':scope > .pane')];
  const part = only && old.length === ss.length && old.every((p, i) => p.dataset.id === ss[i].id);
  const panes = part ? old.filter(p => only.has(p.dataset.id)) : old;
  if (part && !panes.length) return;
  panes.forEach(p => { const h = p.querySelector('.hist'), ta = p.querySelector('textarea'); view[root.id + ':' + p.dataset.id] = { top: h.scrollTop, pinned: h.scrollHeight - h.scrollTop - h.clientHeight < 24, selection: [ta.selectionStart, ta.selectionEnd] }; });
  const a = document.activeElement, caret = a?.matches('textarea, [data-question] input[data-slot]') && root.contains(a) ? { id: a.closest('.pane').dataset.id, n: a.name, s: a.selectionStart, e: a.selectionEnd } : null;
  if (part) panes.forEach(p => { const i = old.indexOf(p), t = document.createElement('template'); t.innerHTML = pane(ss[i], i, bare); attrs(p, t.content.firstElementChild); sync(p, t.content.firstElementChild); });
  else morph(root, ss.map((s, i) => pane(s, i, bare)).join('<div class="handle-v" role="separator" aria-orientation="vertical"></div>'));
  (part ? panes : root.querySelectorAll('.pane')).forEach(p => {
    const s = S.sessions.find(x => x.id === p.dataset.id), h = p.querySelector('.hist'), v = view[root.id + ':' + s.id];
    const place = () => h.scrollTo({ top: !v || v.pinned ? 1e6 : v.top, behavior: 'instant' });
    place(); if (!v) document.fonts.ready.then(() => requestAnimationFrame(place)); // first paint: late font swap leaves it short of the bottom
    p.querySelectorAll('details[data-ev]').forEach(d => d.ontoggle = () => { s.events[d.dataset.ev].open = d.open; });
    p.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => { if (s.live) return liveChat.approve(s, b.dataset.approve); const a = s.events.find(e => e.t === 'approval'); s.events = s.events.filter(e => e !== a); s.pending = null; if (b.dataset.approve === 'reject') { s.events.push({t:'notice', text:'Denied: ' + a.title + '. ' + names[s.agent] + ' will take another approach.'}); reply(s, 'Understood, I will not touch server.ts. I can expose the grace through the existing /api/conversations payload instead; say so and I will do that.'); } else { s.events.push({t:'tool', status:'completed', title:a.title, diff:a.diff}); const plan = s.events.find(e => e.t === 'plan'); if (plan) { plan.entries[2][0] = 'completed'; plan.entries[3][0] = 'in_progress'; } reply(s, 'Bootstrap now carries leaseGraceMs. Next I will read it in the chat-pane footer so the 60 s copy stops being hardcoded.'); } answered(s); });
    const q = p.querySelector('[data-question]'); if (q) { q.oninput = e => { const qe = s.events.find(e => e.t === 'question'); qe.vals = Object.fromEntries(new FormData(q)); (qe.touched ??= new Set()).add(e.target.name.split('~')[0]); }; q.onsubmit = e => { e.preventDefault(); if (s.live) return liveChat.answer(s, Object.fromEntries(new FormData(q))); const v = new FormData(q).get('f0'), qe = s.events.find(e => e.t === 'question'); s.events = s.events.filter(e => e.t !== 'question'); s.pending = null; s.events.push({t:'tool', status:'completed', title:qe.title, output:'answer: ' + v}); reply(s, v); answered(s); }; q.querySelector('[data-decline]').onclick = () => { if (s.live) return liveChat.decline(s); s.events = s.events.filter(e => e.t !== 'question'); s.pending = null; s.events.push({t:'notice', text:'Question declined.'}); answered(s); }; }
    const ta = p.querySelector('textarea');
    if (v?.selection) ta.setSelectionRange(...v.selection);
    // Slash commands: the agent's own list (available_commands_update) while the box holds only "/name"; Tab, Enter or a click fills one in, the agent runs it.
    const slash = p.querySelector('[data-slash]');
    const showSlash = () => {
      const m = /^\/(\S*)$/.exec(ta.value), all = m ? s.commands || lastCommands[s.agent] || [] : [], list = [...all.filter(c => c.name.startsWith(m[1])), ...all.filter(c => !c.name.startsWith(m[1]) && c.name.includes(m[1]))].slice(0, 60); // prefix first, then anywhere; the menu scrolls
      slash.hidden = !list.length;
      slash.innerHTML = list.map(c => `<button type="button" data-cmd="${esc(c.name)}"><b>/${esc(c.name)}</b> <span class="muted">${esc(c.desc)}</span></button>`).join('');
      slash.querySelectorAll('[data-cmd]').forEach(b => b.onmousedown = e => { e.preventDefault(); ta.value = s.draft = '/' + b.dataset.cmd + ' '; showSlash(); ta.focus(); });
    };
    showSlash();
    ta.oninput = () => { s.draft = ta.value; showSlash(); };
    if (caret && caret.id === s.id) { const c = caret.n ? p.querySelector(`[data-question] [name="${caret.n}"]`) : ta; c.focus(); c.setSelectionRange(caret.s, caret.e); }
    // note 8: while a turn runs, Enter queues the message; Ctrl Enter (or Ctrl click) interrupts and sends it now.
    // 2026-10-24: a live chat sends at once, and the daemon puts it into the running turn; it queues only behind messages
    // already queued, or when the daemon refuses it mid-turn (liveChat.prompt).
    const go = now => { const t = ta.value.trim(); if ((!t && !(s.images?.length && (!busy(s) || now))) || s.readonly) return; s.draft = ''; if (!now && (s.live ? s.queue.length : busy(s))) { s.queue.push(t); keepQueue(s); renderChats(); if (bare && settings.closeOnSend) closeModal(); return; } (now ? interrupt : startTurn)(s, t); if (bare && settings.closeOnSend) closeModal(); };
    ta.onkeydown = e => {
      if ((e.key === 'Tab' || e.key === 'Enter' && ta.value !== '/' + slash.querySelector('[data-cmd]')?.dataset.cmd) && !e.shiftKey && !slash.hidden) { e.preventDefault(); slash.querySelector('[data-cmd]').onmousedown(e); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(e.ctrlKey || e.metaKey); }
    };
    p.querySelector('[data-send]').onclick = e => go(e.ctrlKey || e.metaKey);
    const cancel = p.querySelector('[data-cancel]'); if (cancel) cancel.onclick = () => { cancelTurn(s); renderTabs(); renderChats(); };
    p.querySelectorAll('[data-qdel]').forEach(b => b.onclick = () => { s.queue.splice(+b.dataset.qdel, 1); keepQueue(s); renderChats(); });
    p.querySelectorAll('[data-qnow]').forEach(b => b.onclick = () => { const [t] = s.queue.splice(+b.dataset.qnow, 1); keepQueue(s); interrupt(s, t); });
    // note 7: a mode picked mid-turn shows at once but applies when the turn ends
    p.querySelector('[data-mode]').onchange = async e => {
      const m = e.target.value;
      if (LOOSE[m] && !localStorage.getItem('p9-mode-ok:' + m) && !await looseOk(s.agent, m)) { e.target.value = s.modeNext || s.mode; return; }
      localStorage.setItem('p9-mode:' + s.agent, m);
      if (busy(s)) s.modeNext = m === s.mode ? null : m; else { s.mode = m; s.modeNext = null; } renderChats(); };
    p.querySelector('[data-model]').onchange = e => { if (s.live) s.modelPick = e.target.value; };
    p.querySelectorAll('[data-pick]').forEach(el => el.onchange = () => { (s.pick ||= {})[el.dataset.pick] = el.value; });
    p.querySelector('[data-attach]').onclick = () => pickImages(s);
    // A pasted screenshot or files dropped anywhere on the chat attach like the paperclip; pasted text pastes as before.
    ta.onpaste = e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addImages(s, files); } };
    p.ondragover = e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); };
    p.ondrop = e => { const files = [...e.dataTransfer.files]; if (files.length) { e.preventDefault(); addImages(s, files); } };
    p.querySelectorAll('[data-unattach]').forEach(b => b.onclick = () => { s.images.splice(+b.dataset.unattach, 1); renderChats(); });
    const more = p.querySelector('[data-earlier]'); if (more) more.onclick = () => { const h = p.querySelector('.hist'), below = h.scrollHeight - h.scrollTop; s.tail = (s.tail || TAIL) + TAIL; renderChats(); h.scrollTop = h.scrollHeight - below; };
    const st = p.querySelector('[data-start]'); if (st) st.onclick = () => { s.state = 'running'; s.events.push({t:'notice', text:'Connected over ACP · ' + s.model}); renderTabs(); renderChats(); };
    const stop = p.querySelector('[data-stop]'); if (stop) stop.onclick = () => { if (s.live) return liveChat.stop(s); cancelTurn(s, true); s.state = 'stopped'; s.pending = null; s.events = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'); s.events.push({t:'notice', text:'Stopped. Resume continues the native session.'}); renderTabs(); renderChats(); };
    const res = p.querySelector('[data-resume]'); if (res) res.onclick = () => { if (s.live) return p.querySelector('textarea').focus(); s.state = 'running'; s.readonly = false; s.events.push({t:'notice', text:'Resumed natively (session/resume).'}); renderTabs(); renderChats(); };
    p.querySelector('[data-steps]').onclick = () => { hideSteps = !hideSteps; localStorage.setItem('p9-hide-steps', hideSteps ? '1' : '0'); renderChats(); };
    const cl = p.querySelector('[data-close]'); if (cl) cl.onclick = () => closeTab(s.id);
  });
}
function answered(s) {
  if (mdl.open && S.modal?.kind === 'chat' && S.modal.id === s.id) closeModal();
  renderTabs(); renderChats(new Set([s.id]));
}
// Paperclip (Builder, 2026-10-17: it only drew a blue square). Threat model row 20; the daemon checks the same limits.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], MAX_IMAGE = 2 * 1024 * 1024;
const base64 = blob => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
function pickImages(s) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: IMAGE_TYPES.join(','), multiple: true });
  input.onchange = () => addImages(s, input.files);
  input.click();
}
// The paperclip, a pasted screenshot and dropped files all come through here (Builder, 2026-10-18: "not paste the screenshots").
async function addImages(s, files) {
  for (const file of files) {
    if ((s.images ||= []).length >= 4) { toast({ kind: 'not attached', txt: 'Four images a message at most.', level: 'warn' }, true); break; }
    if (!IMAGE_TYPES.includes(file.type)) { toast({ kind: 'not attached', txt: file.name + ': PNG, JPEG, GIF or WebP only.', level: 'warn' }, true); continue; }
    try {
      let blob = file, mimeType = file.type;
      const bmp = await createImageBitmap(file), k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
      if (k < 1 || file.size > MAX_IMAGE * 3 / 4) {
        const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k)); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 }); mimeType = 'image/jpeg';
      }
      const data = await base64(blob);
      if (data.length > MAX_IMAGE) throw new Error('still over 2 MB after scaling');
      s.images.push({ mimeType, data, name: file.name });
    } catch (e) { toast({ kind: 'not attached', txt: file.name + ': ' + (e?.message || e), level: 'warn' }, true); }
  }
  renderChats();
}
function startTurn(s, t) {
  const images = s.images || []; s.images = [];
  if (s.live) return liveChat.prompt(s, t, images);
  if (s.state === 'idle') s.state = 'running';
  s.events.push({t:'user', text:t, when: new Date().toTimeString().slice(0,5), images: images.length || undefined}); view['chats:' + s.id] = view['mdlBody:' + s.id] = null;
  s.events.push({t:'tool', status:'in_progress', title:'Thinking about: ' + t.slice(0, 40)});
  const turn = s.turn = (s.turn || 0) + 1;
  renderTabs(); renderChats();
  setTimeout(() => { if (s.turn !== turn) return; s.events = s.events.filter(e => !(e.t === 'tool' && e.status === 'in_progress' && e.title.startsWith('Thinking'))); reply(s, s.agent === 'claude' ? 'On it. I will check the record before changing anything, then show you the diff before it lands.' : 'Acknowledged. I will stop at the first write that needs you.'); }, 1200);
}
// Builder, 2026-10-21 (an interrupt-and-send message was lost): the daemon refuses a prompt while the cancelled turn is
// still ending (409 turn-running), so a live chat puts the message first in the queue and turn-end sends it.
function interrupt(s, t) {
  if (!busy(s)) return startTurn(s, t);
  if (s.live) { s.queue.unshift(t); keepQueue(s); cancelTurn(s); renderChats(); return; }
  cancelTurn(s); startTurn(s, t);
}
function cancelTurn(s, quiet) {
  if (s.live) { if (!quiet) liveChat.call('cancel', { id: s.id }); return; }
  s.turn = (s.turn || 0) + 1; s.streaming = false; // stale timers see a new turn number and stop
  s.events = s.events.filter(e => !(e.t === 'tool' && e.status === 'in_progress'));
  if (!quiet) s.events.push({t:'notice', text:'Turn cancelled.'});
}
// The end of a turn applies a queued mode, then sends the next queued message.
// Threat model row 21 (Builder, 2026-10-18: no notice when a turn ended): a live turn-end nobody is watching leaves an
// "<agent> finished" card, and a desktop notice while the window is in the background. Only P9's words, never reply text.
function finished(s) {
  if (s.queue.length) return;
  const onScreen = document.hasFocus() && (S.focus === 'chat' && (S.split ? S.open.slice(0, 2) : S.open.slice(0, 1)).includes(s.id) || mdl.open && S.modal?.kind === 'chat' && S.modal.id === s.id);
  if (onScreen) return;
  s.done = true;
  if (!document.hasFocus() && typeof Notification === 'function') { const n = new Notification(names[s.agent] + ' finished', { body: s.title }); n.onclick = () => { window.focus(); openModal({ kind: 'chat', id: s.id }, 'done' + s.id); }; }
}
function turnEnd(s) {
  if (s.modeNext) { s.mode = s.modeNext; s.modeNext = null; s.events.push({t:'notice', text:'Mode is now ' + s.mode + '.'}); }
  if (s.queue.length) { const t = s.queue.shift(); keepQueue(s); startTurn(s, t); } else { renderTabs(); renderChats(new Set([s.id])); } // an interrupt may queue '' (images only)
}
function reply(s, text) {
  const turn = s.turn = (s.turn || 0) + 1; s.streaming = true;
  setTimeout(() => { if (s.turn !== turn) return; s.events.push({t:'agent', text:''}); const ev = s.events[s.events.length - 1]; let i = 0;
    const tick = () => { if (s.turn !== turn) return; i += 3; ev.text = text.slice(0, i); if (i < text.length) { renderChats(); setTimeout(tick, 18); } else { s.streaming = false; turnEnd(s); } }; tick(); }, 500);
}

/* ---------- files ---------- */
function tree(nodes, depth, q, cur) {
  return nodes.map(n => n.kids ? `<button data-dir><span class="k">▾</span><span>${esc(n.name)}</span></button>${tree(n.kids, depth + 1, q, cur)}`.replace('<button data-dir', `<button data-dir style="padding-left:${6 + depth * 12}px"`) : (!q || n.name.toLowerCase().includes(q)) ? `<button data-file="${esc(n.name)}" style="padding-left:${6 + depth * 12}px" aria-current="${cur === n.name}"><span class="k"></span><span>${esc(n.name)}</span>${n.mod ? '<span class="mod" title="modified"></span>' : ''}</button>` : '').join('');
}
// Chat Focus files (Builder, 2026-10-19: "A drop down with the options for "current prject" "workspace" "needs you" "ideas"";
// threat model row 23): real folders through the daemon's read-only list and read, a folder listed when first opened; files
// open read-only (editing is Dev Focus). Current project is the shown chat's folder, else the main project.
// ponytail: listings are cached until the panel is reopened or the scope changes; search filters only folders already open.
const fileScopes = { project: 'Current project', workspace: 'Workspace', needs: 'Needs you', ideas: 'Ideas' };
const files = { scope: 'project', dirs: {}, open: new Set() };
try { const sc = localStorage.getItem('eh-file-scope'); if (Object.hasOwn(fileScopes, sc ?? '')) files.scope = sc; } catch {}
const fileRoot = () => ({ project: () => S.sessions.find(x => x.id === S.open[0])?.folder || live.primary?.path || '', workspace: () => '',
  needs: () => live.waitDir, ideas: () => '_ideas' })[files.scope]();
async function loadDir(dir) {
  files.dirs[dir] = 'loading';
  const r = await window.p9.mission('list', { path: dir });
  files.dirs[dir] = r.status === 200 ? r.body.entries.slice().sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0)) : { error: r.body?.error || String(r.status) };
  renderTree();
}
function liveTree(dir, depth, q, cur) {
  const got = files.dirs[dir], pad = `style="padding-left:${6 + depth * 12}px"`;
  if (!got || got === 'loading') { if (!got) loadDir(dir); return `<p class="sm muted" ${pad}>Loading…</p>`; }
  if (got.error) return `<p class="sm muted" ${pad}>Not readable: ${esc(got.error)}</p>`;
  if (!got.length) return `<p class="sm muted" ${pad}>Empty</p>`;
  return got.filter(e => e.dir || !q || e.name.toLowerCase().includes(q)).map(e => { const p = dir ? dir + '/' + e.name : e.name;
    return e.dir ? `<button data-ldir="${esc(p)}" ${pad}><span class="k">${files.open.has(p) ? '▾' : '▸'}</span><span class="truncate">${esc(e.name)}</span></button>${files.open.has(p) ? liveTree(p, depth + 1, q, cur) : ''}`
      : `<button data-lfile="${esc(p)}" ${pad}${p === cur ? ' aria-current="true"' : ''}><span class="k"></span><span class="truncate">${esc(e.name)}</span></button>`; }).join('');
}
$('#fileScope').innerHTML = Object.entries(fileScopes).map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
$('#fileScope').onchange = e => { files.scope = e.target.value; files.dirs = {}; try { localStorage.setItem('eh-file-scope', files.scope); } catch {} renderTree(); };
function renderTree() {
  const q = $('#fileSearch').value.trim().toLowerCase();
  if (live.on) {
    const root = fileRoot(), cur = S.modal?.kind === 'file' && mdl.open ? S.modal.name : null;
    $('#fileScope').hidden = false; $('#fileScope').value = files.scope;
    $('#tree').innerHTML = `<p class="where muted mono truncate" title="${esc(root || 'Workspace')}">${esc(root || 'Workspace')}</p>${liveTree(root, 0, q, cur)}`;
    $('#tree').querySelectorAll('[data-ldir]').forEach(b => b.onclick = () => { const p = b.dataset.ldir; files.open.has(p) ? files.open.delete(p) : files.open.add(p); renderTree(); });
    $('#tree').querySelectorAll('[data-lfile]').forEach(b => b.onclick = () => openModal({ kind: 'file', name: b.dataset.lfile, live: true }));
    return;
  }
  $('#tree').innerHTML = tree(M.files, 0, q, S.modal?.kind === 'file' && mdl.open ? S.modal.name : null);
  $('#tree').querySelectorAll('[data-file]').forEach(b => b.onclick = () => openModal({ kind: 'file', name: b.dataset.file }));
}
// One doc per file, shared by the Chat file modal and Dev Focus. text is the draft, saved is what
// is on disk; they differ until an explicit Save (D04: a draft never silently overwrites the file).
function doc(name) {
  if (!S.docs[name]) {
    const body = M.fileBody[name] || (name.endsWith('.md') ? `# ${name.split('/').pop()}\n\n(mock file: the real app reads it from disk)\n` : `// ${name}\n// (no preview in this prototype)\n`);
    S.docs[name] = { text: body, saved: body, sel: [0, 0], top: 0 };
  }
  return S.docs[name];
}
const dirty = name => S.docs[name] && S.docs[name].text !== S.docs[name].saved;
// line numbers for wrapped text: each number, then one blank row per extra row its line wraps onto
// ponytail: re-measures the whole file on every keystroke; fine for mock files, the real IDE engine owns this
const mirror = document.createElement('div');
function fitGut(ta, gut) {
  if (!ta.clientWidth) return; // hidden focus: the ResizeObserver runs this again when it shows
  const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight);
  mirror.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:anywhere;font:${cs.font};letter-spacing:${cs.letterSpacing};tab-size:${cs.tabSize};width:${ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`;
  mirror.innerHTML = ta.value.split('\n').map(l => `<div>${esc(l) || ' '}</div>`).join('');
  document.body.append(mirror);
  gut.textContent = [...mirror.children].map((r, i) => (i + 1) + '\n'.repeat(Math.max(1, Math.round(r.offsetHeight / lh)) - 1)).join('\n');
  mirror.remove();
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
  observe(() => fitGut(ta, gut)).observe(ta);
  ta.onselect = ta.onkeyup = ta.onclick = () => { d.sel = [ta.selectionStart, ta.selectionEnd]; };
  ta.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); after(); } };
}
// a _tyler item's file as read-only text: the question line and the empty A. line are already in the review
const fileView = name => doc(name).text.split('\n').filter(l => l.trim() && !/^# |^A\.|^<!--/.test(l)).map(l => `<p>${esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`).join('');
function saveDoc(name) { const d = doc(name); d.saved = d.text; renderTree(); }
const saveBtn = name => dirty(name) ? `<span data-slot="badge">draft</span><button data-slot="button" data-size="sm" data-savefile>Save</button>` : `<span class="muted sm">saved</span>`;
function renderModalFoot() {
  const n = S.modal.name;
  $('#mdlFoot').innerHTML = `<span class="muted sm mono truncate">${esc(n)}</span><span class="spacer"></span><span class="muted sm">Ctrl S</span>${saveBtn(n)}`;
  const b = $('#mdlFoot [data-savefile]'); if (b) b.onclick = () => { saveDoc(n); renderModalFoot(); };
}

/* ---------- Mission Control ---------- */
// workspace-hub's sections from fixtures. Only change from the hub: script buttons are grouped into
// category tiles, each opening a modal (Builder 2026-10-14). Nothing runs; outputs are mock.
// one Catppuccin Mocha accent per word, stable, so a project or kind keeps its colour
const CTP = ['#cba6f7', '#89b4fa', '#94e2d5', '#fab387', '#f5c2e7', '#a6e3a1', '#89dceb', '#f9e2af', '#b4befe', '#eba0ac'];
const tint = s => ` style="--tint:${CTP[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % CTP.length]}"`;
const worst = list => ['bad', 'warn', 'ok'].find(l => list.some(s => s[3] === l)) || 'ok';
const panel = (id, title, body, extra = '') => `<section class="panel" id="${id}"><h3>${title}${extra}</h3><div class="pbody">${body}</div></section>`;
// Live data from the daemon (window.p9.mission) fills the lists once it answers; until then the page says why it is empty.
const live = { on: false, note: window.p9?.mission ? 'Connecting to the P9 daemon…' : 'No P9 daemon in this view', primary: null, waiting: '' };
const usage = { state: 'unavailable', samples: 0, discarded: 0, totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
async function loadUsage() {
  if (!window.p9?.usage) return;
  const result = await window.p9.usage().catch(() => ({ status: 503, body: { state: 'unavailable' } }));
  Object.assign(usage, result.status === 200 ? result.body : { state: 'unavailable' });
  renderMission();
}
// The chat meters read usage.limits: fetched again each minute, which also moves the cache timer on.
const pollUsage = () => { loadUsage().then(renderChats); setTimeout(pollUsage, 60000); };
// Restart P9's background service (finding 6): the one way back for a service that hangs or lost a file, from the Mission
// notes and Settings. Main asks first, and restarts a service that does not answer at all.
const restartBtn = () => (window.p9?.restartService ? ' <button data-slot="button" data-variant="outline" data-restart-btn>Restart P9</button>' : '');
async function restartP9(button) {
  button.disabled = true;
  const r = await window.p9.restartService().catch(() => ({ error: 'restart-failed' }));
  if (r.cancelled) { button.disabled = false; return; }
  toast({ kind: r.restarted ? 'restarted' : 'not restarted', txt: r.restarted ? 'P9 restarted.' : 'Could not restart P9 (' + r.error + ')', level: r.restarted ? 'ok' : 'bad' }, true);
  if (r.restarted) setTimeout(loadMission, 3000); else button.disabled = false;
}
async function loadMission() {
  if (!window.p9?.mission) return;
  const r = await window.p9.mission('overview');
  if (r.status !== 200) {
    const why = r.body?.error || r.status;
    if (sampleView) live.note = 'Sample data: the P9 daemon did not answer (' + why + ')';
    else if (why === 'settings-missing' || why === 'settings-invalid') live.note = 'Mission Control is not set up yet (' + why + '): see Set up P9.';
    // A file the settings name is missing: which one, so the fix is one path in settings.json (finding 5). Retried, as the
    // settings and the files load live.
    else if (why === 'file-not-found') live.note = 'Mission Control cannot find its ' + r.body.setting + ' file, ' + r.body.file + '. Fix that path in P9\'s settings file or create the file; trying again every 5 seconds.';
    else live.note = 'P9\'s background service is not answering (' + why + '). Trying again every 5 seconds.';
    live.noteRestart = !sampleView && why !== 'settings-missing' && why !== 'settings-invalid';
    if (live.noteRestart && !lifetime.signal.aborted) setTimeout(loadMission, 5000);
    return renderMission();
  }
  applyOverview(r.body);
  renderMission(); renderTabs(); loadHub();
}
// Everything one overview carries, so the first load, an answer, a finished turn and the poll below show the same thing.
function applyOverview(o) {
  live.on = true; live.note = ''; live.noteRestart = false; live.restart = o.restart; live.settingsError = o.settingsError; live.primary = o.primary; live.waitDir = o.waiting; dataNote(); live.waiting = o.waiting.split('/').pop();
  M.scripts = {}; M.tools = [];
  for (const x of o.scripts) (M.scripts[x.group || 'Other'] ||= []).push([x.id, x.title, x.desc, 'idle', 'not run here yet', '', { args: x.args, confirm: x.confirm, terminal: x.terminal, live: true }]);
  M.apps = o.apps.map(a => [a.title, a.desc, a.terminal, a.id]);
  M.pages = o.pages.map(x => [x.title, x.url, x.id]);
  // The free-form space: each section is a tile, even one with no buttons yet; its buttons arrived in o.scripts.
  M.space = o.space || [];
  for (const s of M.space) M.scripts[s.title] ||= [];
  applyQueue(o);
}
// M3: a change to settings, the registry or the space shows within one poll. Only while Mission is in front and the window is
// showing; renderMission writes only what changed, so an idle poll costs one local request.
let lastOverview = '';
async function refreshMission() {
  if (!live.on || document.hidden || S.focus !== 'mission' || lifetime.signal.aborted) return;
  const r = await window.p9.mission('overview').catch(() => null);
  if (r?.status !== 200 || lifetime.signal.aborted) return;
  const key = JSON.stringify(r.body); if (key === lastOverview) return; lastOverview = key;
  applyOverview(r.body); renderMission(); renderTabs();
  if (S.modal?.kind === 'scripts' && !M.scripts[S.modal.g]) closeModal(); // its group is gone
  else if (['scripts', 'win', 'reviews', 'center'].includes(S.modal?.kind)) renderModal();
}
const pollMission = () => { refreshMission(); setTimeout(pollMission, 20000); };
// _tyler/ items a chat makes get their card when its turn ends (Builder, 2026-10-17); otherwise the queue is read at start.
let queueTimer = 0;
const queueSoon = () => { clearTimeout(queueTimer); queueTimer = setTimeout(async () => { const r = await window.p9?.mission?.('overview').catch(() => null); if (live.on && r?.status === 200) { lastOverview = JSON.stringify(r.body); applyOverview(r.body); renderMission(); renderTabs(); if (S.modal?.kind === 'reviews' || S.modal?.kind === 'center') renderModal(); } }, 500); };
function applyQueue(o) {
  const drafts = Object.fromEntries(S.reviews.filter(x => x.live).map(x => [x.name, x]));
  const kept = S.reviews.filter(x => x.live && x.draft && x.draft.trim() && !o.queue.some(q => q.name === x.name));
  S.reviews = o.queue.map(q => { const file = live.waiting + '/' + q.name; if (S.docs[file]?.saved !== q.content) S.docs[file] = { text: q.content, saved: q.content, sel: [0, 0], top: 0 };
    return { proj: q.project, kind: 'tyler', txt: q.title, file, age: q.age, updated: q.updated, name: q.name, hash: q.hash, live: true, draft: drafts[q.name]?.draft, sel: drafts[q.name]?.sel }; });
  // ponytail: "already waiting" means present at the first load, so a reload also quiets items a chat made before it.
  if (!S.queueSeen) { S.queueSeen = true; for (const r of S.reviews) S.quiet.add(r.file); }
  // Someone else answered (or removed) an item Builder was writing: keep his text visible, marked, so nothing is lost.
  for (const x of kept) S.reviews.push({ ...x, gone: true, txt: x.txt.replace(/^(?:\(answered elsewhere\) )?/, '(answered elsewhere) ') });

  reviewSort();
}
// _tyler/ items newest first, or by project: the file name starts with it, <project>-<what>.md (Builder, 2026-10-19 #1).
function reviewSort() { const by = localStorage.getItem('eh-review-sort') === 'project' ? 'project' : 'updated';
  S.reviews.sort(by === 'project' ? (a, b) => (a.name || a.proj).localeCompare(b.name || b.proj) : (a, b) => (b.updated || 0) - (a.updated || 0)); return by; }
// The old workspace-hub sections, live: notifications, Wiki inbox, logs and incidents, work in flight, audit, last solo run.
const H = { on: false, notices: [], handoffs: [], timer: 0, hint: '', unchecked: null };
// Why no job was checked: an empty list then never reads as "every job reported in" (finding 8).
const UNCHECKED = { windows: 'P9 runs no workspace shell scripts on Windows', 'no-heartbeats': 'the workspace has no _system/scripts/heartbeats.sh', 'hub-not-set': 'no hub in the Mission settings' };
const noticeLine = () => (H.unchecked ? 'Scheduled jobs not checked: ' + (UNCHECKED[H.unchecked] || H.unchecked) + '.' : H.on && !H.notices ? 'Checking scheduled jobs and setup…' : 'Every scheduled job reported in.');
const ago = min => min < 60 ? min + ' min' : min < 2880 ? Math.round(min / 60) + ' h' : Math.round(min / 1440) + ' d';
async function loadHub() {
  clearTimeout(H.timer);
  const r = await window.p9.mission('hub').catch(() => ({ status: 503 }));
  if (lifetime.signal.aborted) return;
  // No hub in the settings: the sections stay off and the page says why. Asked again, as the settings load live; any other
  // failure is asked again sooner.
  if (r.status !== 200) {
    const off = r.body?.error === 'hub-not-set', hint = off ? 'Logs, incidents and work in flight are off: set hub in the Mission settings file.' : '';
    if (off) H.unchecked = 'hub-not-set';
    if (hint !== H.hint) { H.hint = hint; renderMission(); }
    H.timer = setTimeout(loadHub, off ? 60000 : 15000);
    return;
  }
  const o = r.body; H.on = true; H.hint = ''; H.unchecked = o.unchecked;
  H.handoffs = o.handoffs.sort((a, b) => a.age_days - b.age_days);
  // null while the first doctor sweep runs (it can take two minutes): ask again soon
  H.notices = o.notices && o.notices.map(n => ({ kind: n.kind === 'job' ? 'silent job' : 'setup', txt: n.text, level: 'bad', hub: true }));
  M.inbox = o.inbox.map(b => ({ status: b.decision, pages: b.pages.length, batch: b.branch, live: true }));
  M.logs = { host: '', incidents: o.incidents.map(i => ({ txt: `${i.host} · ${i.check}: failed ${i.count}×, last ${i.failed[0]}${i.resolved ? ' (resolved)' : ''}`, level: i.resolved ? 'ok' : 'bad', req: { kind: 'incident', host: i.host, name: i.name } })),
    rows: o.logs.map(l => [l.name, l.host + ' · ' + ago(l.age_min), l.last, { kind: 'log', host: l.host, name: l.name }]) };
  M.stats = [['Work in flight (HANDOFF.md)', o.handoffs.length], ['Ideas not researched', o.ideas], ['Punch-list items', o.needs_done]];
  M.audit = o.audit.run ? { run: o.audit.run + ' (' + o.audit.review + ')', ticked: o.audit.ticked, total: o.audit.changes, contradictions: o.audit.contradiction_count ?? 0 } : { run: 'none yet', ticked: 0, total: 0, contradictions: 0 };
  M.solo = { when: o.solo.name.replace(/-solo-run-report\.md$/, ''), txt: o.solo.bluf || '(no BLUF line)', live: true };
  renderMission();
  H.timer = setTimeout(loadHub, o.notices ? 60000 : 15000);
}
async function answerLive(r) {
  if (r.gone) return toast({ kind: 'not saved', txt: r.file + ' was answered or removed elsewhere. Copy your text from the box; nothing was written.', level: 'warn' }, true);
  const answer = (r.draft || '').split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  if (!answer) return toast({ kind: 'not saved', txt: 'Write an answer first.', level: 'warn' }, true);
  const res = await window.p9.mission('answer', { name: r.name, hash: r.hash, answer });
  if (res.status === 200) { toast({ kind: 'saved', txt: 'Answer saved to ' + r.file, level: 'ok' }, true); r.draft = ''; }
  // Builder, 2026-10-21: an item with Q1:/Q2: lines and no A. line said "changed on disk" for days, so he kept retrying
  else if (res.body?.error === 'no-empty-answer-line') toast({ kind: 'not saved', txt: r.file + ' has no empty A. line, so P9 cannot write your answer. Ask an agent to add one; your answer is still here.', level: 'bad' }, true);
  else if (res.status === 409) toast({ kind: 'not saved', txt: r.file + ' changed on disk since you opened it. Reloaded it; your answer is still here.', level: 'warn' }, true);
  else toast({ kind: 'not saved', txt: 'Could not save to ' + r.file + ' (' + (res.body?.error || res.status) + ')', level: 'bad' }, true);
  await loadMission();
  if (S.modal?.kind === 'review') { if (S.reviews.length) renderModal(); else closeModal(); }
}
async function runLive(m, id) {
  const res = await window.p9.mission('run', { id, args: m.args, ...(m.armedRun ? { confirm: true } : {}) });
  if (res.status === 200 && res.body.launched) { m.out = ['Opened in a terminal.']; return S.modal === m && renderModal(); }
  if (res.status !== 202) { m.out = ['Refused: ' + (res.body?.reason || res.body?.error || res.status)]; return S.modal === m && renderModal(); }
  let text = '', from = 0;
  for (;;) {
    const o = await window.p9.mission('output', { run: res.body.run, from });
    if (o.status !== 200) { m.out = [text, '[lost the run: ' + (o.body?.error || o.status) + ']']; break; }
    text += o.body.output; from = o.body.next; m.out = text.split('\n');
    if (S.modal === m) renderModal();
    if (o.body.done) break;
    await new Promise(done => setTimeout(done, 300));
  }
  if (S.modal === m) renderModal();
}
// Mission is short: script tiles, then one small card per section (title, a number, one line) that opens the
// section in the modal window (Builder, 2026-10-17: "hard to navigate because its so long ... group everything so
// that its in a window i can open"). Cards are shaped like workspace-hub's Waiting on you and Last solo run boxes.
const sample = () => (sampleView ? ' · sample' : '');
const allNotes = () => [...(H.notices || []), ...S.alerts];
const usageBody = () => (usage.limits ? `<ul class="plist" data-limits>${[limitLine('Claude', usage.limits.claude), limitLine('Codex', usage.limits.codex)].map(l => `<li class="sm${l.stale ? ' muted' : ''}"><b>${l.name}</b> ${esc(l.text)}</li>`).join('')}</ul>` : '')
  + (usage.state === 'unavailable' ? '<p class="empty">No chat token records yet.</p>'
  : `<div class="stats"><div><span>Input tokens</span><b>${usage.totals.inputTokens.toLocaleString()}</b></div><div><span>Output tokens</span><b>${usage.totals.outputTokens.toLocaleString()}</b></div><div><span>Recorded cost</span><b>$${usage.totals.costUsd.toFixed(4)}</b></div></div><p class="sm ${usage.state === 'stale' ? 'muted' : ''}">${usage.state === 'stale' ? 'Stale · ' : ''}${usage.samples} samples · ${usage.discarded} malformed discarded</p>`);
// card() gives [number or name, one line, level]; body() is the window's content (the three lists fill in missionLive)
const wins = {
  mprimary: { show: () => live.primary, title: () => 'Main project', card: () => [live.primary.name, live.primary.status.replace(/\*\*/g, ''), 'ok'],
    body: () => `<p><b>${esc(live.primary.name)}</b> <span class="muted sm mono">${esc(live.primary.path)}</span></p><p class="sm">${esc(live.primary.status.replace(/\*\*/g, ''))}</p>` },
  mnotes: { title: () => 'Notifications' + sample(), card: () => { const n = allNotes(); return [n.length, n[0]?.txt || noticeLine(), n.some(a => a.level === 'bad') ? 'bad' : 'ok']; }, body: () => '' },
  minbox: { show: () => sampleView || H.on, title: () => 'Wiki review inbox' + sample(), card: () => [M.inbox.length, M.inbox.length ? M.inbox.length + ' batch' + (M.inbox.length > 1 ? 'es' : '') + ' to review' : 'No Wiki batches waiting for review.', M.inbox.length ? 'warn' : 'ok'], body: () => '' },
  mlogs: { show: () => sampleView || H.on, title: () => 'Logs and incidents' + sample(), card: () => { const open = M.logs.incidents.filter(i => i.level === 'bad'); return [open.length, open[0]?.txt || M.logs.rows.length + ' logs, no open incident', open.length ? 'bad' : 'ok']; },
    body: () => `<ul class="plist">${M.logs.incidents.map((i, n) => `<li><button data-inc="${n}"${i.level === 'bad' ? ' class="bad fx-halo"' : ''}><span class="lvl" data-l="${esc(i.level)}"></span><span class="txt">${esc(i.txt)}</span></button></li>`).join('')}${M.logs.rows.map((r, n) => `<li class="mono sm"${tint(r[0])}><button data-log="${n}"><b>${esc(r[0])}</b><span class="muted">${esc(r[1])}</span><span class="truncate">${esc(r[2])}</span></button></li>`).join('')}</ul>` },
  mwork: { show: () => sampleView || H.on, title: () => 'Workspace' + sample(), card: () => [M.stats[0][1], `${M.stats[1][1]} ideas · ${M.stats[2][1]} punch-list · solo ${M.solo.when}`, 'ok'],
    body: () => `<div class="stats">${M.stats.map(([k, v], n) => `<div${n === 0 && H.on ? ' data-handoffs role="button" tabindex="0"' : ''}><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div><p class="sm"><span class="kind"${tint('audit')}>audit</span> ${esc(M.audit.run)}: ${esc(M.audit.ticked)} of ${esc(M.audit.total)} ticked, ${esc(M.audit.contradictions)} contradictions</p><p class="sm"${M.solo.live ? ' data-solo role="button" tabindex="0"' : ''}><span class="kind"${tint('last solo run')}>last solo run</span> ${esc(M.solo.when)}: ${esc(M.solo.txt)}</p>` },
  mlaunch: { title: () => 'Apps and pages', card: () => [M.apps.length + M.pages.length, M.apps.concat(M.pages).map(x => x[0]).join(' · ') || 'None in the registry', 'ok'],
    // Each app or page is its own launch tile: P9's icon for P9, a lettered tile in its tint for the rest (Builder, 2026-10-18 #3:
    // "APPs and pages can have the graphic or icon as the button to launch it"). ponytail: the registry has no icon field yet.
    body: () => `<div class="launch">${M.apps.map((a, i) => launchTile(a[0], a[1], `data-app="${i}"`, a[3])).join('')}${M.pages.map((p, i) => launchTile(p[0], p[1], `data-page="${i}"`, '', true)).join('')}</div>` },
  musage: { title: () => 'Usage', card: () => { const c = usage.limits && limitLine('Claude', usage.limits.claude); return [c ? c.text.split(' · ')[0].replace(/ \(.*/, '') : usage.totals.outputTokens.toLocaleString(), c ? 'Claude · ' + c.text : 'output tokens recorded', c?.stale ? 'warn' : 'ok']; }, body: usageBody,
    // On the page: each agent's 5 h and week bars, the same bars as the chat's meters
    inline: () => { const now = Date.now(), rows = Object.keys(names).filter(a => usage.limits?.[a]).map(a => { const lim = usage.limits[a], line = limitLine(names[a], lim, now);
      return `<div class="uagent"><b>${names[a]}</b>${meterBar('5 h', lim.fiveHour, line, now)}${meterBar('Week', lim.sevenDay, line, now)}</div>`; }).join('');
      return (rows || '<p class="empty">No plan limits recorded yet.</p>') + (usage.state === 'unavailable' ? '' : `<p class="sm muted">${usage.totals.outputTokens.toLocaleString()} output tokens · $${usage.totals.costUsd.toFixed(2)} recorded</p>`); } },
};
const launchTile = (name, title, data, id, page) => `<button class="ltile" data-launch="${esc(name)}" ${data} title="${esc(title)}">${id === 'p9' ? '<img src="/p9-icon.png" alt="">' : `<span class="mono-ico"${tint(name)}>${esc(name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?')}</span>`}<span class="nm">${esc(name)}${page ? ' ↗' : ''}</span></button>`;
const winTop = {};
const winCard = id => { const w = wins[id], [big, line, lvl] = w.card();
  return `<button class="win${lvl === 'bad' ? ' bad fx-halo' : ''}" data-win="${id}"><h4><span class="lvl" data-l="${lvl}"></span>${esc(w.title())}</h4><b class="big${id === 'mprimary' ? ' fx-title' : ''}">${esc(big)}</b><span class="line">${esc(line)}</span></button>`; };
// Logs, Usage and Apps sit open on the page and scroll on their own, like Waiting on you (Builder, 2026-10-18 #3); the heading still
// opens the full window.
const PANELS = ['mlogs', 'musage', 'mlaunch'];
const winPanel = id => `<section class="mpanel" data-panel="${id}"><button class="phead" data-win="${id}"><h4>${esc(wins[id].title())}</h4><span>Open</span></button><div class="pscroll"></div></section>`;
function renderMission() {
  const groups = Object.entries(M.scripts);
  setHTML($('#fMission'), `<div class="tiles" aria-label="Script categories">${groups.map(([g, l]) => `<button class="tile${worst(l) === 'bad' ? ' bad fx-halo' : ''}" data-group="${esc(g)}"><span class="lvl" data-l="${worst(l)}"></span><b>${esc(g)}</b><span class="n">${l.length}</span></button>`).join('')}${live.on ? '<button class="tile" data-idea><span></span><b>+ New idea</b></button>' : ''}</div>`
    + (live.note ? `<p class="muted sm" data-mission-note>${esc(live.note)}${live.noteRestart ? restartBtn() : ''}</p>` : '')
    + (live.on && H.hint ? `<p class="muted sm" data-hub-hint>${esc(H.hint)}</p>` : '')
    + (live.settingsError ? `<p class="sm" data-settings-error role="status">settings.json was changed but P9 cannot use it (${esc(live.settingsError)}). It keeps using the earlier settings until the file is fixed.</p>` : '')
    + (live.restart?.needed ? `<p class="sm" data-restart role="status"><b>Restart P9 to apply.</b> The workspace folder ${esc(live.restart.folder)} was not there when P9 started, so it is using the default folder.${restartBtn()}</p>` : '')
    // Waiting on you as a list on the page that scrolls on its own, with the big count workspace-hub had (Builder, 2026-10-18 #3). Three columns fill the window; each list scrolls inside itself.
    + '<div class="mrow"><section class="needs" aria-label="Waiting on you"><div class="nhead"><h4>Waiting on you</h4><select data-slot="select" aria-label="Sort" data-sort><option value="updated">Newest</option><option value="project">Project</option></select></div><div class="bignum"><b data-n></b><span data-unit></span></div><div data-list></div></section>'
    + '<div class="mcol"><div data-card="mprimary"></div>' + PANELS.slice(0, 1).map(winPanel).join('') + '</div>'
    + '<div class="mcol">' + PANELS.slice(1).map(winPanel).join('') + '<div class="wins" aria-label="Mission sections"></div></div></div>');
  $('#fMission').querySelectorAll('[data-group]').forEach(b => b.onclick = () => openModal({ kind: 'scripts', g: b.dataset.group }));
  $('#fMission').querySelectorAll('[data-restart-btn]').forEach(b => b.onclick = () => restartP9(b));
  const sort = $('#fMission [data-sort]'); sort.value = reviewSort(); sort.onchange = () => { try { localStorage.setItem('eh-review-sort', sort.value); } catch {} reviewSort(); missionLive(); };
  // New idea on the page itself, where workspace-hub had it (Builder, 2026-10-18: it was hidden in the Workspace window).
  $('#fMission').querySelectorAll('[data-idea]').forEach(b => b.onclick = () => openModal({ kind: 'idea', name: '', text: '', needs: false }));
  missionLive();
  if (mdl.open && S.modal?.kind === 'win') renderModal();
}
async function launchLive(name, req) {
  const res = await window.p9.mission('launch', req);
  toast({ kind: res.status === 200 ? 'launched' : 'not launched', txt: name + (res.status === 200 ? '' : ' (' + (res.body?.reason || res.body?.error || res.status) + ')'), level: res.status === 200 ? 'ok' : 'bad' }, true);
}
// A section window's buttons; back returns to the window
function bindWin(root, m) {
  const text = (title, req) => H.on && req && openModal({ kind: 'hubtext', title, req, back: m });
  root.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => text(M.logs.incidents[+b.dataset.inc].txt, M.logs.incidents[+b.dataset.inc].req));
  root.querySelectorAll('[data-log]').forEach(b => b.onclick = () => text(M.logs.rows[+b.dataset.log][0], M.logs.rows[+b.dataset.log][3]));
  root.querySelectorAll('[data-solo]').forEach(b => b.onclick = () => text('Last solo run · ' + M.solo.when, { kind: 'solo' }));
  root.querySelectorAll('[data-handoffs]').forEach(b => b.onclick = () => openModal({ kind: 'handoffs', back: m }));
  root.querySelectorAll('[data-launch]').forEach(b => b.onclick = async () => {
    if (!live.on) return toast({ kind: 'launched', txt: b.dataset.launch + ' (mock: nothing opens)', level: 'ok' }, true);
    // A link that is not http(s) opens another program: the full link is shown first, and only Open sends confirm (M6).
    const page = b.dataset.page ? M.pages[+b.dataset.page] : null;
    if (page && !/^https?:\/\//i.test(page[1])) return openModal({ kind: 'link', page, back: m });
    launchLive(b.dataset.launch, b.dataset.page ? { kind: 'pages', id: page[2] } : { kind: 'apps', id: M.apps[+b.dataset.app][3] });
  });
}
// The parts that change: the queue and notices are the same S.reviews and S.alerts the cards use. Redraws the
// section cards, and the open window's list in place (keeping its scroll).
function missionLive() {
  const box = $('#fMission .wins');
  if (box) {
    setHTML(box, Object.keys(wins).filter(id => id !== 'mprimary' && !PANELS.includes(id) && (!wins[id].show || wins[id].show())).map(winCard).join(''));
    setHTML($('#fMission [data-card="mprimary"]'), wins.mprimary.show() ? winCard('mprimary') : '');
    for (const id of PANELS) { const p = $(`#fMission [data-panel="${id}"]`); p.querySelector('h4').textContent = wins[id].title(); bindWin(setHTML(p.querySelector('.pscroll'), (wins[id].inline || wins[id].body)()), { kind: 'win', id }); }
    $('#fMission').querySelectorAll('[data-win]').forEach(b => b.onclick = () => openModal({ kind: 'win', id: b.dataset.win }));
  }
  const set = (id, html) => { const b = $(`#mdl #${id} .pbody`); if (!b) return { querySelectorAll: () => [] }; return setHTML(b, html); };
  const needs = $('#fMission .needs [data-list]'); $('#fMission .needs [data-n]')?.replaceChildren(String(S.reviews.length)); $('#fMission .needs [data-unit]')?.replaceChildren(S.reviews.length === 1 ? ' item' : ' items');
  (needs ? setHTML(needs, S.reviews.length ? `<ul class="plist">${S.reviews.map((r, i) => `<li><button data-i="${esc(i)}"><span class="kind"${tint(r.kind)}>${esc(r.kind)}</span><span class="sm"><span class="tint"${tint(r.proj)}>${esc(r.proj)}</span><span class="muted"> · ${esc(r.age)}</span></span><span class="txt">${esc(r.txt)}</span></button></li>`).join('')}</ul>` : '<p class="empty">Nothing waiting on you.</p>') : { querySelectorAll: () => [] })
    .querySelectorAll('[data-i]').forEach(b => b.onclick = () => openModal({ kind: 'review', i: +b.dataset.i }, 'reviews'));
  const notes = allNotes();
  set('mnotes', notes.length ? `<ul class="plist">${notes.map((a, i) => `<li><button data-i="${esc(i)}"${a.level === 'bad' ? ' class="bad fx-halo"' : ''}><span class="lvl" data-l="${esc(a.level)}"></span><span class="kind"${tint(a.kind)}>${esc(a.kind)}</span><span class="txt">${esc(a.txt)}</span></button></li>`).join('')}</ul>` : `<p class="empty">${esc(noticeLine())}</p>`)
    .querySelectorAll('[data-i]').forEach(b => b.onclick = () => openModal({ kind: 'alert', a: notes[+b.dataset.i], back: S.modal }));
  set('minbox', M.inbox.length ? `<ul class="plist">${M.inbox.map((x, i) => `<li><button data-i="${esc(i)}"><span class="kind"${tint(x.status)}>${esc(x.status)}</span><span class="muted sm">${esc(x.pages)} page${x.pages > 1 ? 's' : ''}</span><span class="txt mono sm">${esc(x.batch)}</span></button></li>`).join('')}</ul>` : '<p class="empty">No Wiki batches waiting for review.</p>')
    .querySelectorAll('[data-i]').forEach(b => b.onclick = () => openModal({ kind: 'inbox', x: M.inbox[+b.dataset.i], back: S.modal }));
}
// Notes (threat model row 34): a folder outside the workspace, named in settings.notes_roots; the daemon checks every path.
// The preview goes through md, which shows raw HTML as text and links and images as plain text (row 18).
const noteKey = (root, path) => 'notes:' + root + '/' + path;
const noteError = { exists: 'A note with that name already exists; nothing was changed.', 'no-such-folder': 'That folder does not exist; make it in your notes app first.',
  'request-refused': 'Use a .md name with no part starting with a dot.' };
function notesModal(m, body, row) {
  $('#mdlT').textContent = m.title + ' · notes';
  if (m.list === undefined) { m.list = null; window.p9.mission('notes', { root: m.root }).then(r => { m.list = r.status === 200 ? r.body : { error: r.body?.error || String(r.status) }; if (S.modal === m) renderModal(); }); }
  const l = m.list, now = Date.now();
  body.innerHTML = !l ? '<p class="sm muted">Loading…</p>' : l.error ? `<p class="sm muted">Could not list the notes (${esc(l.error)})</p>`
    : `<div class="notes-new"><input data-slot="input" data-new value="${esc(m.draftName || '')}" placeholder="folder/new-note.md" aria-label="New note"><button data-slot="button" data-size="sm" data-create>New note</button></div>`
      + (l.files.length ? `<ul class="mlist">${l.files.map((f, i) => row(i, '<span class="kind">md</span>', esc(f.path), esc(ago(Math.max(0, Math.round((now - f.modified) / 60000)))) + ' ago')).join('')}</ul>` : '<p class="empty">No .md notes in this folder yet.</p>');
  $('#mdlFoot').innerHTML = l && !l.error ? `<span class="muted sm" data-notes-count>${l.total > l.files.length ? `Showing the newest ${l.files.length} of ${l.total} notes` : `${l.total} note${l.total === 1 ? '' : 's'}`}${l.partial ? ' · a very big folder: some subfolders were not read' : ''}</span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="sm" data-reload>Reload</button>` : '';
  $('#mdlFoot [data-reload]')?.addEventListener('click', () => { m.list = undefined; renderModal(); });
  body.querySelectorAll('[data-i]').forEach(b => b.onclick = () => openModal({ kind: 'note', root: m.root, path: l.files[+b.dataset.i].path, back: m }));
  const input = body.querySelector('[data-new]'); if (!input) return;
  input.oninput = () => { m.draftName = input.value; };
  const create = async () => {
    let p = (m.draftName || '').trim().replace(/^\/+/, '');
    if (!p) return toast({ kind: 'not saved', txt: 'Type a name for the new note first.', level: 'warn' }, true);
    if (!/\.md$/i.test(p)) p += '.md';
    const r = await window.p9.mission('noteCreate', { root: m.root, path: p, content: '# ' + p.split('/').pop().replace(/\.md$/i, '') + '\n\n' });
    if (r.status === 201) { m.draftName = ''; m.list = undefined; openModal({ kind: 'note', root: m.root, path: r.body.path, edit: true, back: m }); }
    else toast({ kind: 'not saved', txt: p + ': ' + (noteError[r.body?.error] || 'could not create it (' + (r.body?.error || r.status) + ')'), level: 'warn' }, true);
  };
  body.querySelector('[data-create]').onclick = create;
  input.onkeydown = e => { if (e.key === 'Enter') create(); };
}
// One note: the rendered preview, or the editor; Save sends the hash it was read with, so a change on disk is never overwritten.
function noteModal(m, body) {
  const key = noteKey(m.root, m.path);
  $('#mdlT').textContent = m.path;
  // a draft kept from an earlier open keeps the hash it was read with; otherwise read the disk again
  if (!m.asked && !dirty(key)) {
    m.asked = true;
    window.p9.mission('noteRead', { root: m.root, path: m.path }).then(r => {
      if (r.status === 200 && !dirty(key)) S.docs[key] = { text: r.body.content, saved: r.body.content, hash: r.body.hash, sel: [0, 0], top: 0 };
      else if (r.status !== 200) m.error = r.body?.error || String(r.status);
      if (S.modal === m) renderModal();
    });
  }
  const d = S.docs[key];
  if (!d) { body.innerHTML = `<p class="sm muted">${m.error ? 'Not readable: ' + esc(m.error) : 'Loading…'}</p>`; return; }
  const c = m.conflict;
  body.innerHTML = (c ? `<div class="review notes-conflict" data-conflict>${c.diskHash !== undefined
    ? `<p>Changed on disk since you opened it. Your text is still here.</p><div class="notes-row"><button data-slot="button" data-variant="outline" data-size="sm" data-disk>Load disk version</button><button data-slot="button" data-size="sm" data-mine>Save mine over it</button></div>`
    : `<p>This note is no longer on disk (moved, renamed or deleted elsewhere). Your text is still here: copy it before you close.</p><div class="notes-row"><button data-slot="button" data-size="sm" data-copytext>Copy my text</button></div>`}</div>` : '')
    + (m.edit ? editorHtml(key, 'mdlEd') : `<div class="msg agent notes-md" data-preview>${md.parse(d.text)}</div>`);
  if (m.edit) wireEditor(body, key, () => noteFoot(m), () => saveNote(m));
  body.querySelector('[data-disk]')?.addEventListener('click', () => { Object.assign(d, { text: c.diskContent, saved: c.diskContent, hash: c.diskHash }); m.conflict = null; renderModal(); });
  body.querySelector('[data-mine]')?.addEventListener('click', () => saveNote(m, c.diskHash));
  body.querySelector('[data-copytext]')?.addEventListener('click', e => copy(d.text, e.currentTarget));
  noteFoot(m);
}
function noteFoot(m) {
  const key = noteKey(m.root, m.path), base = m.path.split('/').pop();
  $('#mdlFoot').innerHTML = m.renaming
    ? `<input data-slot="input" data-rename value="${esc(m.newName ?? base)}" aria-label="New name"><button data-slot="button" data-size="sm" data-rename-go>Rename</button><button data-slot="button" data-variant="outline" data-size="sm" data-rename-x>Cancel</button>`
    : `<span class="muted sm mono truncate">${esc(m.path)}</span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="sm" data-rename-open>Rename</button><button data-slot="button" data-variant="outline" data-size="sm" data-mode>${m.edit ? 'Preview' : 'Edit'}</button>${dirty(key) ? `<span data-slot="badge">draft</span><button data-slot="button" data-size="sm" data-savenote>Save</button>` : '<span class="muted sm">saved</span>'}`;
  const on = (sel, fn) => { const b = $('#mdlFoot ' + sel); if (b) b.onclick = fn; };
  on('[data-mode]', () => { m.edit = !m.edit; renderModal(); });
  on('[data-savenote]', () => saveNote(m));
  on('[data-rename-open]', () => { m.renaming = true; m.newName = base; noteFoot(m); $('#mdlFoot [data-rename]').focus(); });
  on('[data-rename-x]', () => { m.renaming = false; noteFoot(m); });
  const input = $('#mdlFoot [data-rename]'); if (!input) return;
  input.oninput = () => { m.newName = input.value; };
  const go = async () => {
    let name = (m.newName || '').trim();
    if (name.includes('/')) return toast({ kind: 'not renamed', txt: 'Type a new name only; moving a note to another folder is not supported.', level: 'warn' }, true);
    if (!/\.md$/i.test(name)) name += '.md';
    if (name === base) { m.renaming = false; return noteFoot(m); }
    const r = await window.p9.mission('noteRename', { root: m.root, path: m.path, name });
    if (r.status !== 200) return toast({ kind: 'not renamed', txt: name + ': ' + (noteError[r.body?.error] || 'could not rename it (' + (r.body?.error || r.status) + ')'), level: 'warn' }, true);
    S.docs[noteKey(m.root, r.body.path)] = S.docs[key]; delete S.docs[key];
    m.path = r.body.path; m.renaming = false; if (m.back) m.back.list = undefined;
    toast({ kind: 'renamed', txt: base + ' → ' + name, level: 'ok' }, true);
    if (S.modal === m) renderModal();
  };
  on('[data-rename-go]', go);
  input.onkeydown = e => { if (e.key === 'Enter') go(); else if (e.key === 'Escape') { e.preventDefault(); m.renaming = false; noteFoot(m); } };
}
// The same reply as answerLive: on 409 the draft stays and the banner offers the disk version or a save over it.
async function saveNote(m, hash) {
  const d = S.docs[noteKey(m.root, m.path)]; if (!d || m.saving) return;
  m.saving = true; const text = d.text;
  const r = await window.p9.mission('noteSave', { root: m.root, path: m.path, hash: hash || d.hash, content: text }).catch(() => ({ status: 503 }));
  m.saving = false;
  if (r.status === 200) { d.saved = text; d.hash = r.body.hash; m.conflict = null; toast({ kind: 'saved', txt: 'Saved ' + m.path, level: 'ok' }, true); }
  else if (r.status === 409) { m.conflict = { diskContent: r.body.diskContent, diskHash: r.body.diskHash }; toast({ kind: 'not saved', txt: m.path + ' changed on disk since you opened it. Your text is still here.', level: 'warn' }, true); }
  else toast({ kind: 'not saved', txt: 'Could not save ' + m.path + ' (' + (r.body?.error || r.status) + '). Your text is still here.', level: 'bad' }, true);
  if (S.modal === m) renderModal();
}
// Modal bodies for Mission: a category's buttons, one script (args, Run, output), a Wiki inbox batch
function missionModal(m, body, row) {
  if (m.kind === 'win') {
    const w = wins[m.id]; if (!w || (w.show && !w.show())) return closeModal();
    $('#mdlT').textContent = w.title();
    body.innerHTML = panel(m.id, esc(w.title()), w.body());
    bindWin(body, m); missionLive();
    body.onscroll = () => { winTop[m.id] = body.scrollTop; };
  } else if (m.kind === 'scripts') {
    if (!M.scripts[m.g]) return closeModal();
    const l = M.scripts[m.g], tools = m.g === 'Tools' ? M.tools : [], sp = (M.space || []).find(s => s.title === m.g);
    $('#mdlT').textContent = `${m.g} · ${l.length} script${l.length === 1 ? '' : 's'}`;
    body.innerHTML = (sp?.text ? `<p class="sm" data-space-text>${esc(sp.text)}</p>` : '') + `<ul class="mlist">${sp?.notes ? `<li><button data-notes="${esc(sp.notes)}"><span class="kind">notes</span><span class="truncate">Notes</span><span class="sub truncate">${esc(sp.notes)}</span></button></li>` : ''}${(sp?.logs || []).map(g => `<li><button data-slog="${esc(g.id)}"><span class="kind">log</span><span class="truncate">${esc(g.title)}</span></button></li>`).join('')}${l.map((s, i) => row(i, `<span class="lvl" data-l="${esc(s[3])}"></span>`, esc(s[1]), esc(s[2]) + ' · ' + esc(s[4]) + ', ' + esc(s[5]))).join('')}${tools.map(t => `<li><button data-tool="${esc(t[0])}"><span class="kind">tool</span><span class="truncate">${esc(t[0])}</span><span class="sub truncate">${esc(t[1])}</span></button></li>`).join('')}</ul>`;
    body.querySelectorAll('[data-i]').forEach(b => b.onclick = () => openModal({ kind: 'script', s: l[+b.dataset.i], back: m }));
    body.querySelectorAll('[data-slog]').forEach(b => b.onclick = () => openModal({ kind: 'hubtext', title: b.textContent.replace(/^log/, ''), req: { kind: 'space', name: b.dataset.slog }, back: m }));
    body.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => toast({ kind: 'launched', txt: b.dataset.tool + ' (mock: nothing opens)', level: 'ok' }, true));
    body.querySelectorAll('[data-notes]').forEach(b => b.onclick = () => openModal({ kind: 'notes', root: b.dataset.notes, title: m.g, back: m }));
  } else if (m.kind === 'notes') notesModal(m, body, row);
  else if (m.kind === 'note') noteModal(m, body);
  else if (m.kind === 'link') {
    $('#mdlT').textContent = 'Open ' + m.page[0] + '?';
    body.innerHTML = `<div class="review"><p>This opens another program on this computer with this link:</p><pre class="out" data-link>${esc(m.page[1])}</pre><p class="muted sm">It is on your allowed-schemes list in settings.json. Only open it if you recognise it.</p></div>`;
    $('#mdlFoot').innerHTML = `<span class="spacer"></span><button data-slot="button" data-variant="outline" data-cancel>Cancel</button><button data-slot="button" data-open>Open link</button>`;
    $('#mdlFoot [data-cancel]').onclick = () => (m.back ? openModal(m.back) : closeModal());
    $('#mdlFoot [data-open]').onclick = () => { launchLive(m.page[0], { kind: 'pages', id: m.page[2], confirm: true }); m.back ? openModal(m.back) : closeModal(); };
  } else if (m.kind === 'script') {
    const [id, name, desc, lvl, last, dur, x = {}] = m.s;
    m.args ||= (x.args || []).map(() => '');
    $('#mdlT').textContent = name;
    body.innerHTML = `<div class="review"><span class="kind"><span class="lvl" data-l="${esc(lvl)}"></span> last run ${esc(last)} · ${esc(dur)}</span><p>${esc(desc)}</p>${(x.args || []).map((a, i) => a.choices ? `<label>${esc(a.label)}<select data-slot="select" data-arg="${i}"><option value="">(none)</option>${a.choices.map(ch => `<option${m.args[i] === ch ? ' selected' : ''}>${esc(ch)}</option>`).join('')}</select></label>` : `<label>${esc(a.label ?? a)}<input data-slot="input" data-arg="${i}" value="${esc(m.args[i])}"></label>`).join('')}${m.out ? `<pre class="out">${esc(m.out.join('\n'))}</pre>` : ''}</div>`;
    body.querySelectorAll('[data-arg]').forEach(inp => inp.oninput = inp.onchange = () => { m.args[+inp.dataset.arg] = inp.value; });
    $('#mdlFoot').innerHTML = `<span class="muted sm">${x.confirm ? 'Changes things: asks before it runs' : x.live ? (x.terminal ? 'Opens in a terminal' : 'Runs on this computer') : 'Mock: nothing runs'}</span><span class="spacer"></span>${m.out ? '<button data-slot="button" data-variant="outline" data-copy>Copy output</button>' : ''}<button data-slot="button" data-run>${m.armed ? 'Confirm run' : 'Run'}</button>`;
    $('#mdlFoot [data-run]').onclick = () => {
      if (x.confirm && !m.armed) { m.armed = true; return renderModal(); }
      m.armedRun = m.armed; m.armed = false; m.out = ['running…']; renderModal();
      if (x.live) return runLive(m, id);
      setTimeout(() => { m.out = M.outputs[id] || [name, '', '[ok] ' + name + ' completed']; if (S.modal === m) renderModal(); }, 600);
    };
    if (m.out) $('#mdlFoot [data-copy]').onclick = e => copy(m.out.join('\n'), e.currentTarget);
  } else if (m.kind === 'hubtext') {
    $('#mdlT').textContent = m.title;
    if (m.text === undefined) { m.text = 'Loading…'; window.p9.mission('hubText', m.req).then(r => { m.text = r.status === 200 ? r.body.text : 'Could not read it (' + (r.body?.error || r.status) + ')'; if (S.modal === m) renderModal(); }); }
    body.innerHTML = `<div class="review"><pre class="out">${esc(m.text)}</pre></div>`;
    const fix = m.req?.kind === 'incident' && liveChat.on;
    $('#mdlFoot').innerHTML = `<span class="spacer"></span>${fix ? '<button data-slot="button" data-fix>Fix with Claude</button>' : ''}<button data-slot="button" data-variant="outline" data-copy>Copy</button>`;
    $('#mdlFoot [data-copy]').onclick = e => copy(m.text, e.currentTarget);
    // The daemon starts the chat; the 'created' event adds the session, so the chat modal fills in as events arrive.
    if (fix) $('#mdlFoot [data-fix]').onclick = async () => {
      const r = await window.p9.mission('fix', { host: m.req.host, name: m.req.name });
      if (r.status === 201) openModal({ kind: 'chat', id: r.body.conversation, back: m });
      else toast({ kind: 'chat', txt: 'Fix with Claude: ' + (r.body?.error || r.status), level: 'bad' }, true);
    };
  } else if (m.kind === 'idea') {
    // workspace-hub's New idea box: the daemon names the file and refuses to replace one.
    $('#mdlT').textContent = 'New idea';
    body.innerHTML = `<div class="review"><p class="sm muted">Saved to _ideas/, or _ideas/needs-done/ for a fix to something that already exists.</p><label>Name<input data-slot="input" data-idea-name value="${esc(m.name)}" placeholder="short-name"></label><label>Idea<textarea data-idea-text rows="8">${esc(m.text)}</textarea></label><label class="sm"><input type="checkbox" data-idea-needs${m.needs ? ' checked' : ''}> A fix for an existing project (needs-done)</label></div>`;
    body.querySelector('[data-idea-name]').oninput = e => { m.name = e.target.value; };
    body.querySelector('[data-idea-text]').oninput = e => { m.text = e.target.value; };
    body.querySelector('[data-idea-needs]').onchange = e => { m.needs = e.target.checked; };
    $('#mdlFoot').innerHTML = '<span class="spacer"></span><button data-slot="button" data-idea-save>Save idea</button>';
    $('#mdlFoot [data-idea-save]').onclick = async () => {
      const r = await window.p9.mission('idea', { name: m.name, text: m.text, needs_done: m.needs });
      toast({ kind: r.status === 201 ? 'saved' : 'not saved', txt: r.status === 201 ? r.body.path : 'New idea: ' + (r.body?.error || r.status), level: r.status === 201 ? 'ok' : 'bad' }, true);
      if (r.status === 201) { closeModal(); loadHub(); }
    };
  } else if (m.kind === 'handoffs') {
    $('#mdlT').textContent = `Work in flight · ${H.handoffs.length} HANDOFF.md`;
    body.innerHTML = `<ul class="mlist">${H.handoffs.map((x, i) => row(i, '', esc(x.project), 'updated ' + esc(x.age_days) + ' d ago')).join('')}</ul>`;
    body.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const x = H.handoffs[+b.dataset.i]; openModal({ kind: 'hubtext', title: x.project + '/HANDOFF.md', req: { kind: 'handoff', name: x.project }, back: m }); });
    $('#mdlFoot').innerHTML = '';
  } else if (m.kind === 'inbox' && m.x.live) {
    const x = m.x; $('#mdlT').textContent = x.batch;
    if (m.text === undefined) { m.text = 'Loading…'; window.p9.mission('hubText', { kind: 'inbox', name: x.batch }).then(r => { m.text = r.status === 200 ? r.body.text : 'Could not read it (' + (r.body?.error || r.status) + ')'; if (S.modal === m) renderModal(); }); }
    body.innerHTML = `<div class="review"><span class="kind">${esc(x.status)} · ${esc(x.pages)} page${x.pages > 1 ? 's' : ''}</span><pre class="out">${esc(m.text)}</pre></div>`;
    $('#mdlFoot').innerHTML = `<span class="muted sm">The Librarian applies your call on its next run</span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-st="reject">Reject</button><button data-slot="button" data-st="merge">Approve</button>`;
    $('#mdlFoot').querySelectorAll('[data-st]').forEach(b => b.onclick = async () => {
      const r = await window.p9.mission('hubDecide', { name: x.batch, choice: b.dataset.st });
      toast({ kind: r.status === 200 ? 'saved' : 'not saved', txt: x.batch + (r.status === 200 ? ' marked ' + b.dataset.st : ' (' + (r.body?.error || r.status) + ')'), level: r.status === 200 ? 'ok' : 'bad' }, true);
      closeModal(); loadHub();
    });
  } else if (m.kind === 'inbox') {
    const x = m.x; $('#mdlT').textContent = x.batch;
    body.innerHTML = `<div class="review"><span class="kind">${esc(x.status)} · ${esc(x.pages)} page${x.pages > 1 ? 's' : ''}</span><pre class="out">${esc(x.body)}</pre></div>`;
    $('#mdlFoot').innerHTML = `<span class="muted sm">The Librarian applies your call on its next run</span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-st="reject">Reject</button><button data-slot="button" data-st="merge">Approve</button>`;
    $('#mdlFoot').querySelectorAll('[data-st]').forEach(b => b.onclick = () => { x.status = b.dataset.st === 'merge' ? 'approved' : 'rejected'; missionLive(); closeModal(); });
  } else return false;
  return true;
}

/* ---------- Dev Focus ---------- */
// devChrome repaints tabs, explorer and the save bar; renderDev also rebuilds the editor (tab switch only)
function devChrome() {
  const v = S.dev, tabs = $('#devTabs'), n = v.active;
  tabs.innerHTML = v.tabs.map(f => `<button class="tab" role="tab" data-file="${esc(f)}" aria-selected="${n === f}"><span class="mono">${esc(f.split('/').pop())}</span>${dirty(f) ? '<span class="mod" title="Unsaved draft"></span>' : ''}<span class="close" title="Close (the draft is kept)">${svg.x}</span></button>`).join('');
  tabs.querySelectorAll('.tab').forEach(b => b.onclick = e => { const f = b.dataset.file; if (e.target.closest('.close')) { v.tabs = v.tabs.filter(x => x !== f); if (v.active === f) v.active = v.tabs.at(-1) || null; } else v.active = f; renderDev(); });
  tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#devTree').innerHTML = tree(M.files, 0, '', n);
  $('#devTree').querySelectorAll('[data-file]').forEach(b => b.onclick = () => openDev(b.dataset.file));
  const bar = $('#devMain .ebar'); if (!bar) return;
  bar.innerHTML = `<span class="mono truncate">${esc(n)}</span><span class="spacer" style="flex:1"></span><span class="muted sm">Ctrl S</span>${saveBtn(n)}`;
  const s = bar.querySelector('[data-savefile]'); if (s) s.onclick = () => { saveDoc(n); devChrome(); };
}
function renderDev() {
  const n = S.dev.active, main = $('#devMain');
  main.innerHTML = n ? `<div class="ebar"></div>${editorHtml(n, 'devEd')}` : '<p class="empty">Open a file from the explorer.</p>';
  if (n) wireEditor(main, n, devChrome);
  devChrome();
}
function openDev(name) { if (!S.dev.tabs.includes(name)) S.dev.tabs.push(name); S.dev.active = name; renderDev(); }
// D05 + D10-4: a file modal promoted to primary opens in Dev Focus with the same draft and caret
function devPrimary(name) {
  S.primary = () => { const ta = $('#devEd'); ta.focus(); ta.setSelectionRange(...doc(name).sel); };
  closeModal(); setFocus('dev'); openDev(name);
}
$('#fileSearch').oninput = renderTree;

/* ---------- rail + dock ---------- */
$('#rFiles').onclick = () => { S.files = !S.files; $('#files').hidden = !S.files; $('#rFiles').setAttribute('aria-pressed', S.files); if (S.files && live.on) { files.dirs = {}; renderTree(); } };
$('#rSplit').onclick = () => { S.split = !S.split; if (S.split && S.open.length < 2) { const s = S.sessions.findLast(x => !x.hidden && !S.open.includes(x.id)); if (s) S.open.push(s.id); } $('#rSplit').setAttribute('aria-pressed', S.split); renderTabs(); renderChats(); };
$('#rTerm').onclick = () => toggleTerm();
$('#rSearch').onclick = () => { if (!S.files) $('#rFiles').click(); $('#fileSearch').focus(); };
// One shared shell; each focus remembers whether it shows it and how (Builder 2026-10-14):
// Dev opens it as a drawer, Chat and Mission as a pop-out. dFloat flips the mode for that focus.
function showTerm() {
  const f = S.focus, open = S.termOpen[f];
  dock.hidden = !open; dock.classList.toggle('float', S.termMode[f] === 'float');
  $('#rTerm').setAttribute('aria-pressed', open);
  if (open && dockTerm && !dockTerm.open) openDock();
}
function toggleTerm() { S.termOpen[S.focus] = !S.termOpen[S.focus]; showTerm(); }
$('#dHide').onclick = toggleTerm;

/* ---------- focus modes ---------- */
// Theme per focus mode (phase 18): each focus keeps the look last picked while it showed; a focus with none keeps the current look.
const focusLooks = (() => { try { return JSON.parse(localStorage.getItem('p9-focus-looks')) ?? {}; } catch { return {}; } })();
onLookChange(look => { focusLooks[S.focus] = look; try { localStorage.setItem('p9-focus-looks', JSON.stringify(focusLooks)); } catch {} });
// All three focus panes stay in the DOM; switching only flips visibility, so nothing re-renders.
// A pick (rail, keys, CLI, landing) leaves the landing page and is kept as the last focus; `stay` is the app's own switching.
function setFocus(f, stay = false) {
  if (!settings.focus[f]) return; // turned off in Settings
  S.focus = f;
  if (f === 'mission') refreshMission();
  if (!stay) { try { localStorage.setItem('p9-last-focus', f); } catch {} leaveLanding(); }
  if (focusLooks[f]?.theme) { applyLook(focusLooks[f]); DUWOP.init(); }
  document.querySelectorAll('.fpane').forEach(p => { const on = p.dataset.focus === f; p.classList.toggle('on', on); p.inert = !on; });
  document.querySelector('.shell').dataset.focus = f;
  document.querySelectorAll('[data-focus-btn]').forEach(b => b.setAttribute('aria-pressed', b.dataset.focusBtn === f));
  renderIndicator(); // each focus has its own pets
  $('#focusTitle').textContent = focusNames[f];
  showTerm();
  placeDev();
}
// In the desktop, Dev Focus is the real editor: a separate view (p9://dev) laid over this pane. In a browser the sample editor stays.
// The view draws above this page, so it steps aside: hidden while a dialog is open, and short of the cards' column while a card shows.
function placeDev() {
  if (!window.p9?.devView) return;
  const r = $('#fDev').getBoundingClientRect(), c = $('#cards').getBoundingClientRect();
  const visible = S.focus === 'dev' && r.width > 0 && r.height > 0 && !document.querySelector('dialog[open]');
  let x = r.x, y = r.y, right = c.height > 0 && c.left < r.right ? c.left - 8 : r.right;
  // The walkthrough card is on this page too: the editor starts right of it or below it, whichever leaves more editor.
  const k = $('#walk')?.getBoundingClientRect();
  if (k && k.right > x && k.left < right && k.bottom > y && k.top < r.bottom) {
    if ((right - k.right) * (r.bottom - y) >= (right - x) * (r.bottom - k.bottom)) x = k.right + 8; else y = k.bottom + 8;
  }
  window.p9.devView(visible ? { visible, x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(0, right - x)), height: Math.round(Math.max(0, r.bottom - y)) } : { visible });
}
new ResizeObserver(placeDev).observe($('#fDev'));
new ResizeObserver(placeDev).observe($('#cards'));
new MutationObserver(placeDev).observe(document.body, { subtree: true, attributeFilter: ['open'] });
window.p9?.onFocus?.(f => { if (Object.hasOwn(focusNames, f)) setFocus(f); });
document.querySelectorAll('[data-focus-btn]').forEach(b => b.onclick = () => setFocus(b.dataset.focusBtn));
// Ctrl+1/2/3 is what Builder asked for; Chrome keeps Ctrl+1-8 for its own tabs, so Alt+1/2/3 works in a browser too.
addEventListener('keydown', e => {
  const f = { Digit1: 'chat', Digit2: 'dev', Digit3: 'mission' }[e.code];
  if (f && (e.ctrlKey || e.altKey) && !e.shiftKey) { e.preventDefault(); setFocus(f); }
  if (e.code === 'Backquote' && e.ctrlKey) { e.preventDefault(); toggleTerm(); }
});
$('#term').innerHTML = M.terminal.map(l => `<span class="${l.startsWith('user@') ? 'cmd' : l.startsWith('✔') ? 'ok' : ''}">${esc(l)}</span>`).join('\n') + '<span class="caret"></span>';
// Live, the dock is a real shell (Builder, 2026-10-18: "1. Yes"): one of P9's own tmux sessions, the same ones the phone's
// Terminal tab lists. terminal.mjs is the phone's code; main holds the socket and relays its frames to this stand-in.
let relay = null;
function relaySocket(id) {
  const socket = relay = { readyState: 0, binaryType: 'arraybuffer', serial: null, onopen: null, onmessage: null, onclose: null,
    send: frame => { if (socket.readyState === 1) window.p9.terminalSend(socket.serial, frame); },
    close: () => { if (socket.readyState === 3) return; socket.readyState = 3; if (socket.serial) window.p9.terminalClose(socket.serial); } };
  const fail = () => { if (socket.readyState === 3) return; socket.readyState = 3; socket.onclose?.({ code: 1011 }); };
  window.p9.terminalOpen(id).then(serial => { if (!serial) return fail(); socket.serial = serial; if (socket.readyState === 3) window.p9.terminalClose(serial); }, fail);
  return socket;
}
window.p9?.onTerminal?.((serial, m) => {
  const socket = relay; if (!socket || socket.serial !== serial || socket.readyState === 3) return;
  if (m.open) { socket.readyState = 1; socket.onopen?.(); }
  else if (typeof m.text === 'string') socket.onmessage?.({ data: m.text });
  else if (m.bytes) socket.onmessage?.({ data: m.bytes });
  else if ('close' in m) { socket.readyState = 3; socket.onclose?.({ code: m.close }); }
});
// Loaded in the window only: the page is prerendered in Node, where xterm has no named exports.
let dockTerm = null, tmuxMissing = '', unavailableText = null, noteShown = false;
// The install lines are too long for the toolbar's one-line state, so the dock body carries them; Refresh clears them.
const noTmux = () => { dockTerm.show('tmux not found'); $('#termView').textContent = tmuxMissing; noteShown = true; };
// No backend on this computer (issue #11): the badge says so instead of 'closed', which read as a daemon that was down.
const noTerminal = (reason) => {
  dockTerm.show(unavailableText()); $('#dBadge').textContent = 'unavailable';
  $('#termView').textContent = unavailableText(reason); noteShown = true;
};
// Opening the dock attaches the newest running shell, or starts one.
let docking = null;
const openDock = () => docking ??= (async () => {
  if (noteShown) { $('#termView').textContent = ''; noteShown = false; }
  const list = await window.p9.terminal('list').catch(() => null);
  if (list?.body?.error === 'tmux-not-found') return noTmux();
  if (list?.body?.error === 'terminal-unavailable') return noTerminal(list.body.reason);
  if (list?.status !== 200) return dockTerm.show('Terminals are unavailable');
  let id = list.body.terminals.filter(x => x.state === 'running').at(-1)?.id;
  if (!id) {
    const made = await window.p9.terminal('create').catch(() => null);
    if (made?.body?.error === 'terminal-unavailable') return noTerminal(made.body.reason);
    if (made?.status !== 201) return made?.body?.error === 'tmux-not-found' ? noTmux() : dockTerm.show('Not started: ' + (made?.body?.error ?? 'daemon unavailable'));
    id = made.body.terminal;
  }
  dockTerm.attach(id); dockTerm.focus();
})().finally(() => { docking = null; });
if (window.p9?.terminalOpen) import('./terminal.mjs').then(({ createTerminal, TMUX_MISSING, unavailableText: text }) => {
  if (lifetime.signal.aborted) return;
  tmuxMissing = TMUX_MISSING; unavailableText = text;
  dockTerm = createTerminal({ screen: $('#termView'), connect: relaySocket, state: (text, on) => {
    $('#dState').textContent = text; $('#dBadge').textContent = on ? 'running' : 'closed'; $('#dBadge').dataset.variant = on ? 'ok' : 'warn'; $('#dRefresh').hidden = on; } });
  $('#term').hidden = true; $('#termView').hidden = false;
  dockTerm.show('No terminal open');
  $('#dRefresh').onclick = openDock;
  observe(() => dockTerm.fit()).observe($('#termView'));
  lifetime.signal.addEventListener('abort', () => dockTerm.close());
  showTerm();
});
let dragY = null; const dock = $('#dock');
$('#grip').onpointerdown = e => { dragY = e.clientY; const h0 = dock.offsetHeight; const mv = ev => { dock.style.height = Math.max(120, Math.min(innerHeight * .7, h0 + (dragY - ev.clientY))) + 'px'; }; const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); }; addEventListener('pointermove', mv); addEventListener('pointerup', up); };
$('#grip').onkeydown = e => { if (e.key === 'ArrowUp') dock.style.height = dock.offsetHeight + 24 + 'px'; if (e.key === 'ArrowDown') dock.style.height = Math.max(120, dock.offsetHeight - 24) + 'px'; };
$('#dFloat').onclick = () => { S.termMode[S.focus] = S.termMode[S.focus] === 'float' ? 'drawer' : 'float'; dock.style.height = dock.style.left = dock.style.top = dock.style.translate = ''; showTerm(); };
// Floating terminal (Builder, 2026-10-17: "wigs out on click and drag to move, highlights all the stuff below it, and wont resize").
// left/top are relative to the dock's parent, not the viewport (the jump); pointer capture and preventDefault stop the selection;
// CSS resize: both gives the corner handle.
dock.querySelector('.tb').onpointerdown = e => {
  if (!dock.classList.contains('float') || e.target.closest('button') || e.button !== 0) return;
  e.preventDefault(); const tb = e.currentTarget; tb.setPointerCapture(e.pointerId);
  const r = dock.getBoundingClientRect(), pr = dock.offsetParent.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
  dock.style.translate = 'none';
  const place = ev => { dock.style.left = Math.max(0, Math.min(pr.width - 80, ev.clientX - dx - pr.left)) + 'px'; dock.style.top = Math.max(0, Math.min(pr.height - 30, ev.clientY - dy - pr.top)) + 'px'; };
  place(e); tb.onpointermove = place; tb.onpointerup = tb.onpointercancel = () => { tb.onpointermove = tb.onpointerup = tb.onpointercancel = null; };
};

/* ---------- stop all + palette ---------- */
$('#stopAll').onclick = () => $('#stopDlg').showModal();
$('#stopKeep').onclick = () => $('#stopDlg').close();
let persistent = localStorage.getItem('p9-session-mode') !== 'dies-with-app';
function showSessionMode() {
  $('#sessionMode').textContent = persistent ? 'Persistent: on' : 'Dies with app: on';
  $('#sessionModeNote').textContent = persistent ? 'Persistent is the default. Closing the UI keeps owned work running.' : 'Dies with app is on. Quitting the UI runs Stop All first.';
}
showSessionMode();
window.p9?.lifecycle?.('mode', { persistent });
$('#sessionMode').onclick = () => {
  persistent = !persistent;
  localStorage.setItem('p9-session-mode', persistent ? 'persistent' : 'dies-with-app');
  window.p9?.lifecycle?.('mode', { persistent });
  showSessionMode();
};
$('#stopGo').onclick = () => { if (liveChat.on) { S.sessions.filter(s => s.live && s.state === 'running').forEach(s => { s.state = 'stopping'; }); liveChat.call('stopAll'); } else S.sessions.forEach(s => { if (s.state === 'running') { s.state = 'stopped'; s.pending = null; s.events = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'); s.events.push({t:'notice', text:'Stopped by Stop All at ' + new Date().toTimeString().slice(0,5) + '.'}); } }); $('#stopDlg').close(); renderTabs(); renderChats(); };
/* ---------- walkthrough (first login, then Ctrl K) ---------- */
// The guide pet is Chat's system pet at Settings' largest size, 128 px (Builder, 2026-10-19); without one the bubble is text only. A step whose
// element is hidden or empty is shown in the middle of the window. Ends back in the focus it started from.
function walkthrough(i = 0, from = S.focus) {
  leaveLanding();
  document.querySelector('.walk-at')?.classList.remove('walk-at'); $('#walk')?.remove();
  const step = WALKTHROUGH[i];
  if (!step) return setFocus(from);
  if (step.focus && step.focus !== S.focus) setFocus(step.focus);
  const pet = [settings.pet.chat?.system, settings.pet[S.focus]?.system].find(n => n && IND.looks.get(n)), last = i + 1 === WALKTHROUGH.length;
  document.body.insertAdjacentHTML('beforeend', `<div id="walk" class="walk" role="dialog" aria-label="${esc(step.title)}">${pet ? petCanvas(pet, '3', 128, false) : ''}<div><div class="eyebrow">${i + 1} of ${WALKTHROUGH.length}</div><h3>${esc(step.title)}</h3><p>${esc(step.text)}</p><div class="walk-foot"><button data-slot="button" data-variant="ghost" data-size="sm" data-walk="${WALKTHROUGH.length}">Skip</button><span class="spacer"></span>${i ? `<button data-slot="button" data-variant="outline" data-size="sm" data-walk="${i - 1}">Back</button>` : ''}<button data-slot="button" data-variant="default" data-size="sm" data-walk="${i + 1}">${last ? 'Done' : 'Next'}</button></div></div></div>`);
  const el = $('#walk'), at = step.at && $(step.at), w = el.offsetWidth, h = el.offsetHeight;
  at?.classList.add('walk-at'); // before measuring: an empty row (no running chats yet) takes a minimum size from it
  const r = at?.getBoundingClientRect(), clamp = (v, max) => Math.min(Math.max(12, v), max - 12);
  if (!r?.width || !r.height) { at?.classList.remove('walk-at'); Object.assign(el.style, { left: (innerWidth - w) / 2 + 'px', top: (innerHeight - h) / 2 + 'px' }); }
  else {
    if (r.left < 80) Object.assign(el.style, { left: r.right + 14 + 'px', top: clamp(r.top - 8, innerHeight - h) + 'px' }); // the rail: beside it
    else Object.assign(el.style, { left: clamp(r.left, innerWidth - w) + 'px', top: (r.bottom + 14 + h < innerHeight ? r.bottom + 14 : clamp(r.top - 14 - h, innerHeight - h)) + 'px' });
  }
  el.querySelectorAll('[data-walk]').forEach(b => b.onclick = () => walkthrough(+b.dataset.walk, from));
  el.onkeydown = e => { if (e.key === 'Escape') walkthrough(WALKTHROUGH.length, from); };
  el.querySelector(`[data-walk="${i + 1}"]`).focus();
  placeDev();
  tickPets();
}
const cmds = [['Notification Center', () => openModal({ kind: 'center' })], ['Walkthrough', () => walkthrough()],['Simulate an agent question', () => askNow()], ['Simulate a system notification', () => toast({ kind: 'silent job', txt: 'nightly-backup did not report in', level: 'bad' })], ['Chat Focus', () => setFocus('chat')], ['Dev Focus', () => setFocus('dev')], ['Mission Control', () => setFocus('mission')], ['New Codex session', () => newSession('codex', 'gpt-5.1-codex')], ['New Claude session', () => newSession('claude', 'Opus 5.5')], ['Toggle chat split', () => $('#rSplit').click()], ['Browse files', () => $('#rSearch').click()], ['Toggle files pane', () => $('#rFiles').click()], ['Toggle terminal', toggleTerm], ['Stop all sessions', () => $('#stopAll').click()], ['Look: Event Horizon', () => DUWOP.set('event-horizon')], ['Look: Redline', () => DUWOP.set('redline')], ['Look: Night Drive', () => DUWOP.set('night-drive')], ['Look: Duskwood', () => DUWOP.set('duskwood')]];
let palSel = 0;
function renderPal() { const q = $('#palIn').value.toLowerCase(); const list = cmds.filter(c => c[0].toLowerCase().includes(q)); palSel = Math.min(palSel, Math.max(0, list.length - 1)); $('#palList').innerHTML = list.map((c, i) => `<li role="option" aria-selected="${i === palSel}" data-i="${cmds.indexOf(c)}">${svg.bolt.replace('<svg', '<svg width="14" height="14"')}${esc(c[0])}${i === palSel ? '<kbd>↵</kbd>' : ''}</li>`).join('') || '<li class="muted">No matching command</li>'; $('#palList').querySelectorAll('li[data-i]').forEach(li => li.onclick = () => run(+li.dataset.i)); }
function run(i) { $('#palette').close(); cmds[i][1](); }
function openPal() { $('#palIn').value = ''; palSel = 0; renderPal(); $('#palette').showModal(); $('#palIn').focus(); }
$('#rCmd').onclick = openPal;
$('#palIn').oninput = () => { palSel = 0; renderPal(); };
$('#palIn').onkeydown = e => { const n = $('#palList').querySelectorAll('li[data-i]').length; if (e.key === 'ArrowDown') { palSel = (palSel + 1) % n; renderPal(); } if (e.key === 'ArrowUp') { palSel = (palSel - 1 + n) % n; renderPal(); } if (e.key === 'Enter') { const li = $('#palList').querySelector('li[aria-selected="true"]'); if (li) run(+li.dataset.i); } };
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#palette').open ? $('#palette').close() : openPal(); } });

/* ---------- settings (phase 18) ---------- */
// The desktop keeps them in its profile folder (main.mjs checks the shape); a browser preview keeps them in localStorage.
// The agent lock is the daemon's (threat model row 15): this page only shows and asks to change it.
let settings = { name: '', startLast: false, zoom: 1, closeOnSend: false, focus: { chat: true, dev: true, mission: true }, pet: { chat: { ...DEFAULT_PET }, dev: { ...DEFAULT_PET, on: false }, mission: { ...DEFAULT_PET, on: false } } }, agentLock = null, fileProtect = null, pets = null, petMode = null;
async function saveSettings(next) {
  try { settings = window.p9?.setSettings ? await window.p9.setSettings(next) : (localStorage.setItem('p9-settings', JSON.stringify(next)), next); }
  catch { toast({ kind: 'settings', txt: 'Settings not saved', level: 'bad' }, true); }
  applySettings();
}
function applySettings() {
  document.querySelectorAll('[data-focus-btn]').forEach(b => { b.hidden = !settings.focus[b.dataset.focusBtn]; });
  if (!settings.focus[S.focus]) setFocus(Object.keys(settings.focus).find(f => settings.focus[f]), true);
  if ($('#setDlg').open) renderSettings();
  loadPetLook();
}
// Pets in Settings: the library (add from a folder picker, remove), then one focus mode's pets at a time.
const PET_WHY = { name: 'its folder name must be lowercase letters, digits and dashes', invalid: 'it is not a petdex pet (pet.json and a sheet)', exists: 'a pet with that name is already in P9', command: 'paste the install command from petdex.dev', unknown: 'petdex.dev has no pet by that name', offline: 'petdex.dev could not be reached' };
function petSettings() {
  const mode = petMode ||= S.focus, f = settings.pet[mode], pick = (role, label, none) => `<label class="set-row"><span><strong>${label}</strong></span><span class="spacer"></span><select data-slot="input" id="setPet-${role}" data-pet-role="${role}"><option value="">${none}</option>${pets.pets.map(p => `<option value="${esc(p.name)}" ${f[role] === p.name ? 'selected' : ''}>${esc(p.displayName)}</option>`).join('')}</select></label>`;
  return `<fieldset class="set-group"><legend>Pets</legend>`
    + `<p class="muted sm">Find a pet at <a id="petdexLink" href="https://petdex.dev" target="_blank" rel="noopener">petdex.dev</a>, copy its install command and paste it below.</p>`
    + (window.p9?.installPets ? `<form class="set-row" id="petInstallForm"><input data-slot="input" id="petInstall" placeholder="npx petdex@latest install boba" autocomplete="off" spellcheck="false" style="flex:1"><button data-slot="button" data-variant="default" id="petInstallGo">Install</button></form>` : '')
    + `<div class="pet-lib">${pets.pets.map(p => `<figure><canvas data-thumb="${esc(p.name)}" width="192" height="208"></canvas><figcaption>${esc(p.displayName)}</figcaption><button data-slot="button" data-variant="ghost" data-size="icon-sm" data-pet-remove="${esc(p.name)}" title="Remove ${esc(p.displayName)}">×</button></figure>`).join('') || '<p class="muted sm">No pets yet.</p>'}</div>`
    + (window.p9?.addPets ? `<div class="set-row">${pets.importable ? `<button data-slot="button" data-variant="default" id="petImport">Import ${pets.importable} new petdex pet${pets.importable === 1 ? '' : 's'}</button>` : ''}<button data-slot="button" data-variant="outline" id="petAdd">Add pets…</button></div>` : '')
    + `<div class="set-row" role="group" aria-label="Focus mode">${Object.entries(focusNames).map(([m, n]) => `<button data-slot="button" data-variant="${m === mode ? 'default' : 'outline'}" data-size="sm" data-pet-mode="${m}" aria-pressed="${m === mode}">${n}</button>`).join('')}</div>`
    + `<label class="set-row"><input type="checkbox" id="setPetOn" ${f.on ? 'checked' : ''}><span><strong>Show pets in ${focusNames[mode]}</strong><span class="muted sm">Off: chats show no pet. The top-bar pet always shows.</span></span></label>`
    + `<label class="set-row"><span><strong>Size</strong></span><span class="spacer"></span><input type="range" id="setPetSize" min="24" max="128" step="4" value="${f.size}"><span class="mono">${f.size}px</span></label>`
    + pick('system', 'System', 'None (spinner)') + pick('claude', 'Claude', 'Same as System') + pick('codex', 'Codex', 'Same as System')
    + `<div class="set-row"><span class="muted sm">Show, size and positions stay per focus.</span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="sm" id="petAll" ${Object.values(settings.pet).every(o => PET_ROLES.every(r => o[r] === f[r])) ? 'disabled' : ''}>Use these pets in all focus modes</button></div>`
    + `<div class="set-row"><span class="muted sm">Drag a pet to move it.</span><span class="spacer"></span><button data-slot="button" data-variant="ghost" data-size="sm" id="petReset" ${f.top || f.pane || Object.keys(petSpots).length ? '' : 'disabled'}>Reset positions</button></div></fieldset>`;
}
function wirePetSettings() {
  const mode = petMode, setPet = change => saveSettings({ ...settings, pet: { ...settings.pet, [mode]: { ...settings.pet[mode], ...change } } });
  document.querySelectorAll('[data-pet-role]').forEach(sel => { sel.onchange = e => setPet({ [sel.dataset.petRole]: e.target.value || null }); });
  document.querySelectorAll('[data-pet-mode]').forEach(b => { b.onclick = () => { petMode = b.dataset.petMode; renderSettings(); }; });
  $('#setPetOn').onchange = e => setPet({ on: e.target.checked });
  $('#setPetSize').onchange = e => setPet({ size: +e.target.value });
  $('#setPetSize').oninput = e => { e.target.nextElementSibling.textContent = e.target.value + 'px'; };
  $('#petReset').onclick = () => { for (const k in petSpots) delete petSpots[k]; localStorage.removeItem('p9-pet-spots'); setPet({ top: null, pane: null }); };
  // Builder, 2026-10-19: copy this focus's three pet picks to every focus; show, size and positions stay per focus.
  $('#petAll').onclick = () => saveSettings({ ...settings, pet: Object.fromEntries(Object.entries(settings.pet).map(([m, o]) => [m, { ...o, ...Object.fromEntries(PET_ROLES.map(r => [r, settings.pet[mode][r]])) }])) });
  const refresh = async () => { pets = await window.p9.listPets().catch(() => pets); renderSettings(); };
  const addWith = add => async () => {
    const r = await add().catch(() => null);
    if (!r) return toast({ kind: 'pets', txt: 'Pets not added', level: 'bad' }, true);
    if (r.added.length || r.refused.length) toast({ kind: 'pets', level: r.refused.length ? 'warn' : 'ok', txt: [r.added.length && 'Added ' + r.added.map(p => p.name).join(', ') + '.', ...r.refused.map(p => `${p.name} not added: ${PET_WHY[p.why] || p.why}.`)].filter(Boolean).join(' ') }, true);
    refresh();
  };
  $('#petdexLink').onclick = e => { if (window.p9?.openPetdex) { e.preventDefault(); window.p9.openPetdex(); } }; // a browser preview follows the link
  if ($('#petAdd')) $('#petAdd').onclick = addWith(() => window.p9.addPets());
  if ($('#petImport')) $('#petImport').onclick = addWith(() => window.p9.importPets());
  if ($('#petInstallForm')) $('#petInstallForm').onsubmit = e => { e.preventDefault(); $('#petInstallGo').disabled = true; $('#petInstallGo').textContent = 'Installing…'; addWith(() => window.p9.installPets($('#petInstall').value))().finally(renderSettings); };
  document.querySelectorAll('[data-pet-remove]').forEach(b => { b.onclick = async () => {
    const name = b.dataset.petRemove, shown = pets.pets.find(p => p.name === name)?.displayName || name;
    if (!confirm(`Remove ${shown} from P9? Any copy in ~/.codex/pets stays.`)) return;
    if (!(await window.p9.removePet(name).catch(() => null))) return toast({ kind: 'pets', txt: shown + ' not removed', level: 'bad' }, true);
    IND.looks.delete(name);
    const clear = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, ['claude', 'codex', 'system'].includes(k) && v === name ? null : v]));
    await saveSettings({ ...settings, pet: Object.fromEntries(Object.entries(settings.pet).map(([m, f]) => [m, clear(f)])) });
    refresh();
  }; });
  document.querySelectorAll('canvas[data-thumb]').forEach(async cv => {
    const name = cv.dataset.thumb;
    if (!IND.looks.has(name)) IND.looks.set(name, await petLook(name));
    const look = IND.looks.get(name); if (look) cv.getContext('2d').drawImage(look.img, 0, 0, 192, 208, 0, 0, 192, 208);
  });
}
function renderSettings() {
  const on = Object.values(settings.focus).filter(Boolean).length;
  const box = (id, label, checked, note = '', disabled = false) => `<label class="set-row"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span><strong>${label}</strong>${note ? `<span class="muted sm">${note}</span>` : ''}</span></label>`;
  $('#setBody').innerHTML = (window.p9?.setSettings ? `<div class="set-row"><span><strong>Zoom</strong><span class="muted sm">Ctrl = and Ctrl - from the shell; Ctrl 0 resets</span></span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="icon-sm" id="zOut" title="Zoom out">−</button><span class="mono" id="zVal">${Math.round(settings.zoom * 100)}%</span><button data-slot="button" data-variant="outline" data-size="icon-sm" id="zIn" title="Zoom in">+</button><button data-slot="button" data-variant="ghost" data-size="sm" id="zReset">Reset</button></div>` : '')
    + `<label class="set-row"><span><strong>Your name</strong><span class="muted sm">The landing page greets you with it. Empty: no name.</span></span><span class="spacer"></span><input data-slot="input" id="setName" maxlength="40" autocomplete="off" spellcheck="false"></label>`
    + box('setStartLast', 'Start in my last focus mode', settings.startLast, 'Skips the landing page when P9 opens. The Event Horizon mark, top left, still opens it.')
    + box('setCloseSend', 'Close the chat window on send', settings.closeOnSend, 'A chat opened from a card or the Notification Center closes once your message is sent.')
    + `<fieldset class="set-group"><legend>Focus modes</legend>${Object.entries(focusNames).map(([f, n]) => box('setF-' + f, n, settings.focus[f], '', settings.focus[f] && on === 1)).join('')}</fieldset>`
    + (pets ? petSettings() : '')
    + (window.p9?.chat ? box('setLock', 'Agent lock', agentLock === true, agentLock === null ? 'Unknown: the daemon did not answer.' : 'Agents can read and answer, but cannot edit files or run anything that asks permission. Enforced by the daemon.', agentLock === null) : '')
    + (window.p9?.fileProtection ? box('setProtect', 'File protection', fileProtect !== false, fileProtect === null ? 'Unknown: the daemon did not answer.' : fileProtect ? 'The editor, here and on your phone, cannot open or change secrets, .env files, _private, .git or P9\'s own files. Turning it off asks first.' : 'Off: the editor, here and on your phone, can open and change any file, including secrets and .git.', fileProtect === null) : '')
    + (window.p9?.openUpdates ? `<div class="set-row"><span><strong>Updates</strong><span class="muted sm" id="setVer">You have P9 ${esc(window.p9.version || '?')}. Opens GitHub's newest release in your browser; if its number is higher, ${/Windows/.test(navigator.userAgent) ? 'download its .exe there and run it. Your workspace and settings stay.' : 'update as the README\'s Update section says (git pull, build, restart).'}</span></span><span class="spacer"></span><button data-slot="button" data-variant="outline" id="setUpd">Check for updates</button></div>` : '')
    + `<div class="set-row"><a data-slot="button" data-variant="outline" id="setDocs" href="https://github.com/JudgeBreddd/p9#readme" target="_blank" rel="noopener">P9 docs on GitHub</a><button data-slot="button" data-variant="outline" id="setAm">Anymouse</button>${window.p9?.chat ? '<button data-slot="button" data-variant="outline" id="setWel">Setup</button>' + restartBtn().replace('data-restart-btn', 'id="setRestart"') : ''}</div>`;
  const zoom = z => saveSettings({ ...settings, zoom: Math.round(Math.min(3, Math.max(0.5, z)) * 10) / 10 });
  if ($('#zIn')) { $('#zIn').onclick = () => zoom(settings.zoom + 0.1); $('#zOut').onclick = () => zoom(settings.zoom - 0.1); $('#zReset').onclick = () => zoom(1); }
  $('#setName').value = settings.name || '';
  $('#setName').onchange = e => saveSettings({ ...settings, name: e.target.value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 40) });
  $('#setStartLast').onchange = e => saveSettings({ ...settings, startLast: e.target.checked });
  $('#setCloseSend').onchange = e => saveSettings({ ...settings, closeOnSend: e.target.checked });
  if (pets) wirePetSettings();
  Object.keys(focusNames).forEach(f => { $('#setF-' + f).onchange = e => saveSettings({ ...settings, focus: { ...settings.focus, [f]: e.target.checked } }); });
  if ($('#setLock')) $('#setLock').onchange = async e => { const r = await liveChat.call('setLock', { on: e.target.checked }); agentLock = r.status === 200 ? r.body.on : agentLock; renderSettings(); };
  // Main shows the warning when this turns it off; the box then shows what the daemon says, so a "Keep" answer re-checks it.
  if ($('#setProtect')) $('#setProtect').onchange = async e => { const r = await window.p9.fileProtection(e.target.checked).catch(() => null); fileProtect = r?.status === 200 ? r.body.on : fileProtect; renderSettings(); };
  if ($('#setUpd')) $('#setUpd').onclick = () => window.p9.openUpdates();
  $('#setDocs').onclick = e => { if (window.p9?.openDocs) { e.preventDefault(); window.p9.openDocs(); } }; // a browser preview follows the link
  $('#setAm').onclick = () => { $('#setDlg').close(); $('#amBtn').click(); };
  if ($('#setWel')) $('#setWel').onclick = () => { $('#setDlg').close(); welcome(); };
  if ($('#setRestart')) $('#setRestart').onclick = () => restartP9($('#setRestart'));
}
$('#setBtn').onclick = async () => {
  if (window.p9?.listPets) pets = await window.p9.listPets().catch(() => null);
  if (window.p9?.chat) { const r = await liveChat.call('lock'); agentLock = r.status === 200 ? r.body.on : null; }
  if (window.p9?.fileProtection) { const r = await window.p9.fileProtection().catch(() => null); fileProtect = r?.status === 200 ? r.body.on : null; }
  petMode = null; renderSettings(); $('#setDlg').showModal();
};
$('#setClose').onclick = () => $('#setDlg').close();
addEventListener('keydown', e => {
  const z = { Equal: settings.zoom + 0.1, Minus: settings.zoom - 0.1, Digit0: 1 }[e.code];
  if (!e.ctrlKey || e.altKey || z === undefined || !window.p9?.setSettings) return;
  e.preventDefault(); saveSettings({ ...settings, zoom: Math.round(Math.min(3, Math.max(0.5, z)) * 10) / 10 });
});
(async () => {
  const start = settings;
  try { settings = window.p9?.getSettings ? await window.p9.getSettings() : JSON.parse(localStorage.getItem('p9-settings')) || settings; } catch {}
  if (!settings.pet?.chat) settings = { ...start, ...settings, pet: start.pet }; // a browser preview may hold an older shape
  applySettings();
  landingStart();
})();
setTimeout(landingStart, 3000); // settings never answered: open anyway rather than leave the window dark

/* ---------- landing page (Builder, plan.md "Landing page" and _tyler/p9-landing-page.md) ---------- */
// P9 opens on it: the black hole's intro (2.6 s; only Space skips), then a greeting, the focus modes and the installed pets
// while the hole turns slowly behind. Any focus pick (a button, 1 2 3, Ctrl 1-3, the CLI) leaves it; Esc goes to the last
// focus. Settings' "Start in my last focus mode" skips it, and so does a reload of the same window (hot reload).
// The test runs turn it off (P9_LANDING=off, scripts/with-tmp.mjs): it covers the shell they click.
const land = $('#land'), landOn = window.p9?.landing !== false, still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sky = createSky($('#landSky')), SKY_MAIN = { uDist: 34, uShift: 0.2, uIgnite: 1, uStars: 1, uDim: 0.62 };
const LAND = { started: false, raf: 0, v: { ...SKY_MAIN }, from: null, to: null, t0: 0, ms: 0, drawn: 0, spin: 0 };
if (!landOn) land.removeAttribute('data-pending');
const lastFocus = () => { let f = null; try { f = localStorage.getItem('p9-last-focus'); } catch {} return settings.focus[f] ? f : Object.keys(focusNames).find(k => settings.focus[k]); };
function landingStart() {
  if (LAND.started) return;
  LAND.started = true;
  if (!landOn) return;
  let landed = false; try { landed = !!sessionStorage.getItem('p9-landed'); } catch {}
  if (landed || settings.startLast) { land.removeAttribute('data-pending'); setFocus(lastFocus(), true); return; }
  openLanding(true);
}
function openLanding(intro) {
  land.removeAttribute('data-pending');
  intro &&= !still;
  land.classList.remove('leaving');
  land.dataset.stage = intro ? 'intro' : 'main';
  land.toggleAttribute('data-run', intro);
  if (!land.open) land.showModal();
  land.focus();
  landGreeting(); landStatus(); landPets();
  land.querySelectorAll('[data-land]').forEach(b => { b.hidden = !settings.focus[b.dataset.land]; });
  LAND.v = intro ? { uDist: 30, uShift: 0, uIgnite: 0, uStars: 0, uDim: 1 } : { ...SKY_MAIN };
  if (intro) { tweenSky({ uDist: 22, uIgnite: 1, uStars: 1 }, 2400); LAND.intro = setTimeout(landMain, 2600); }
  if (!sky.ok) return;
  if (still) { sky.size(1); sky.set({ ...LAND.v, uSpin: 4, uTime: 4 }); sky.frame(); }
  else if (!LAND.raf) { LAND.drawn = 0; LAND.raf = requestAnimationFrame(skyFrame); }
}
function landMain() {
  if (land.dataset.stage === 'main') return;
  clearTimeout(LAND.intro);
  land.dataset.stage = 'main';
  tweenSky(SKY_MAIN, 900);
}
const tweenSky = (to, ms) => { Object.assign(LAND, { from: { ...LAND.v }, to, t0: performance.now(), ms }); };
// The intro draws at 60 % of the window's pixels; behind the main stage, all of them at 30 frames a second (45 % looked
// soft on a 1x screen, Builder, 2026-10-19).
function skyFrame(now) {
  LAND.raf = requestAnimationFrame(skyFrame);
  const main = land.dataset.stage === 'main' && !LAND.to;
  if (main && now - LAND.drawn < 33) return;
  const dt = LAND.drawn ? Math.min(0.1, (now - LAND.drawn) / 1000) : 0; LAND.drawn = now;
  if (LAND.to) {
    const k = Math.min(1, (now - LAND.t0) / LAND.ms), e = 1 - (1 - k) ** 5;
    for (const key in LAND.to) LAND.v[key] = LAND.from[key] + (LAND.to[key] - LAND.from[key]) * e;
    if (k === 1) LAND.to = null;
  }
  LAND.spin += dt * (land.dataset.stage === 'main' ? 0.25 : 0.8);
  sky.size(main ? 1 : 0.6);
  sky.set({ ...LAND.v, uSpin: LAND.spin, uTime: now / 1000 });
  sky.frame();
}
function leaveLanding() {
  if (!land.open || land.classList.contains('leaving')) return;
  land.classList.add('leaving');
  setTimeout(() => land.close(), still ? 0 : 420);
}
land.addEventListener('close', () => {
  try { sessionStorage.setItem('p9-landed', '1'); } catch {}
  land.classList.remove('leaving');
  cancelAnimationFrame(LAND.raf); LAND.raf = 0;
  clearTimeout(LAND.intro); clearTimeout(LAND.status);
  $('#landPets').replaceChildren();
  // The walkthrough runs once, the first time the landing page closes, starting in Chat and ending in the focus picked
  // (Builder approved it in _tyler/p9-walkthrough-review.md: "A."; GitHub issue #4 item 2). Ctrl K brings it back.
  let walked = true; try { walked = !!localStorage.getItem('p9-walked'); localStorage.setItem('p9-walked', '1'); } catch {}
  if (!walked) firstRun(); // the setup wizard first, while a check fails
});
// Esc on the main stage goes to the last focus; during the intro it does nothing (only Space skips).
land.addEventListener('cancel', e => { e.preventDefault(); if (land.dataset.stage === 'main') setFocus(lastFocus()); });
land.addEventListener('keydown', e => {
  if (e.ctrlKey || e.altKey || e.metaKey) return; // Ctrl 1-3 is the global switch
  if (land.dataset.stage === 'intro') { if (e.code === 'Space') { e.preventDefault(); landMain(); } return; }
  const f = { Digit1: 'chat', Digit2: 'dev', Digit3: 'mission', Numpad1: 'chat', Numpad2: 'dev', Numpad3: 'mission' }[e.code];
  if (f && settings.focus[f]) { e.preventDefault(); setFocus(f); }
});
land.querySelectorAll('[data-land]').forEach(b => {
  b.querySelector('.ic').innerHTML = svg[{ chat: 'chat', dev: 'code', mission: 'gauge' }[b.dataset.land]];
  b.onclick = () => setFocus(b.dataset.land);
});
$('#landSet').innerHTML = svg.gear;
$('#landSet').onclick = () => $('#setBtn').click();
$('#brandBtn').onclick = () => openLanding(false);
// Half the greetings know the time of day, half do not. The name goes in as text, never as markup.
const GREET = {
  morning: ['Good morning, {n}', 'Morning, {n}. Coffee first?', 'Rise and build, {n}'],
  afternoon: ['Good afternoon, {n}', 'Afternoon, {n}. Where were we?'],
  evening: ['Good evening, {n}', 'Evening, {n}. One more thing?'],
  night: ['Burning the midnight oil, {n}?', 'Still up, {n}?', 'Night shift, {n}?'],
  any: ['{n} returns!', 'Welcome back, {n}', 'What are we building, {n}?', 'The agents missed you, {n}', 'Gravity pulled you back, {n}'],
};
function landGreeting(now = new Date()) {
  const h = now.getHours(), name = settings.name || '';
  let lines = Math.random() < 0.5 ? GREET[h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night'] : GREET.any;
  if (!name) lines = lines.filter(l => !l.startsWith('{n}')).map(l => l.replace(', {n}', ''));
  const [before, after = ''] = lines[Math.floor(Math.random() * lines.length)].split('{n}');
  const em = document.createElement('em'); em.textContent = name;
  $('#landHi').replaceChildren(before, ...(name ? [em, after] : []));
}
// What is going on, refreshed each second while the landing shows.
function landStatus() {
  const running = S.sessions.filter(s => s.state === 'running').length, need = S.sessions.filter(s => s.pending).length + S.reviews.filter(r => !S.quiet.has(r.file)).length;
  const parts = [running && `${running} chat${running === 1 ? '' : 's'} running`, need && `${need} need${need === 1 ? 's' : ''} you`].filter(Boolean);
  $('#landSub').textContent = parts.length ? parts.join(' · ') : 'All quiet. Where to?';
  LAND.status = setTimeout(() => { if (land.open) landStatus(); }, 1000);
}
// Up to 12 installed pets, each on its own clock: idle, waving, jumping, thinking, waiting, running. A click makes one jump.
const LAND_ROWS = ['0', '0', '3', '4', '8', '6', '7'];
async function landPets() {
  const box = $('#landPets'), list = window.p9?.listPets ? (await window.p9.listPets().catch(() => null))?.pets?.slice(0, 12) ?? [] : [];
  for (const p of list) if (!IND.looks.has(p.name)) IND.looks.set(p.name, await petLook(p.name));
  if (!land.open) return;
  box.innerHTML = list.filter(p => IND.looks.get(p.name)).map(p => petCanvas(p.name, '0', innerHeight < 700 ? 60 : 72, false)).join('');
  box.querySelectorAll('canvas.pet').forEach(cv => {
    const look = IND.looks.get(cv.dataset.petName), rows = LAND_ROWS.filter(r => r === '0' || look.rows[r] > 1);
    cv.title = look.displayName; cv.dataset.phase = Math.floor(Math.random() * 8);
    const act = (row, ms) => { clearTimeout(cv.timer); cv.dataset.rows = row; cv.timer = setTimeout(() => { if (cv.isConnected) act(rows[Math.floor(Math.random() * rows.length)], 1800 + Math.random() * 4200); }, ms); };
    act('0', 600 + Math.random() * 3000);
    cv.onclick = () => act(look.rows[4] > 1 ? '4' : '3', 1500);
  });
  tickPets();
}

/* ---------- first-run setup wizard (v0.1.3 C1; threat model rows 17, 31, 32) ---------- */
// Seven screens (Builder approved them, 2026-10-22). It opens itself once, after the landing intro and before the walkthrough.
// Skip, or the Set up card's x, moves the card into the Notification Center until all four checks pass ("4 auto and if its
// skipped, add it to notifications that goes away when its completed"). Nothing is stored but the skip: an open re-reads
// /setup and the sign-in state every 2 s and starts at the first step not done. A failure shows its cause, one fix and Retry.
async function loadSetup(paths) {
  if (!window.p9?.chat) return null;
  const r = await liveChat.call('setup', paths || {}).catch(() => null);
  return r?.status === 200 ? r.body : null;
}
// The four checks the card counts. Off Linux tmux is null and counts as done: the dock's terminals are tmux there only.
function setupDone(s) { return { workspace: s.writable, agents: s.claude || s.codex, mission: s.settings && s.agentsFile && s.registryFile, terminal: s.tmux !== false }; }
function welSkipped() { try { return localStorage.getItem('p9-welcome-skipped') === '1'; } catch { return false; } }
const STEP_NAMES = { workspace: 'workspace folder', agents: 'agent sign-in', mission: 'Mission Control files', terminal: 'terminal' };
async function checkSetup() {
  const s = await loadSetup();
  S.setup = s && Object.values(setupDone(s)).includes(false) ? s : null;
  renderCards();
}
function skipWelcome() { try { localStorage.setItem('p9-welcome-skipped', '1'); } catch {} renderCards(); }
function tour() { const from = S.focus; setFocus('chat', true); walkthrough(0, from); }
// First run (the landing page closed for the first time): the wizard while a check fails, then the walkthrough.
async function firstRun() {
  const s = await loadSetup();
  if (!s || welSkipped() || !Object.values(setupDone(s)).includes(false)) return tour();
  W.then = tour; welcome(0);
}
const W = { i: 0, s: null, login: {}, timer: 0, note: {}, code: '', name: null, busy: '', then: null, paths: null };
// The paths the wizard would write: the owner's edits, else what the daemon proposed (what it found, filled in with the
// starter paths). Empty fields are left out; hub is optional.
const PATH_KEYS = [['primary', 'Main AGENTS file', 'setup-file'], ['registry', 'Mission Control registry', 'setup-file'], ['waiting', 'Waiting-on-you folder', 'setup-folder'], ['hub', 'workspace-hub folder (optional)', 'setup-folder'], ['scripts_root', 'Folder the registry commands run from (optional, full path)', '']];
const wizPaths = () => Object.fromEntries(Object.entries(W.paths || W.s?.proposed || {}).filter(([k, v]) => PATH_KEYS.some(([key]) => key === k) && v));
const wizChoosing = s => s && ((!s.settings && !s.settingsPresent) || s.conflict);
const wizSteps = () => ['welcome', 'workspace', 'agents', 'mission', ...(W.s?.tmux === null ? [] : ['terminal']), 'you', 'done'];
async function welcome(at) {
  if (!window.p9?.chat) return; // a browser preview has no daemon to set up
  Object.assign(W, { note: {}, code: '', name: null, busy: '', paths: null });
  W.s = await loadSetup();
  const d = W.s && setupDone(W.s);
  W.i = at ?? Math.max(0, d ? wizSteps().findIndex(k => d[k] === false) : 0);
  await wizRefresh();
  if (!$('#welDlg').open) $('#welDlg').showModal();
  clearInterval(W.timer); W.timer = setInterval(wizRefresh, 2000);
}
async function wizRefresh() {
  const [s, l] = await Promise.all([loadSetup(W.paths && wizPaths()), window.p9.agentLogin('state').catch(() => null)]);
  W.s = s; W.login = l?.status === 200 ? l.body : {};
  if (s) { S.setup = Object.values(setupDone(s)).includes(false) ? s : null; renderCards(); }
  wizRender();
}
// Each error a step can get back, as [cause, fix].
const WIZ_ERR = {
  'daemon-unavailable': ["P9's background service is not answering.", 'It restarts on its own. Retry in a few seconds.'],
  'workspace-change-unsupported': ["On this system the folder can't be changed from here.", 'P9 changes it on Linux and Windows.'],
  'workspace-refused': ["That folder can't be the workspace.", "Pick a folder of your own: not your home folder itself, a drive's root or P9's own state folder."],
  'service-missing': ["P9's background service is not installed.", "Run P9's installer again (the README's Install section), then Retry."],
  'stop-all-failed': ['Something running would not stop, so the folder stayed the same.', 'Stop it in Chat or the terminal dock, then Change the folder again.'],
  'workspace-not-started': ['P9 could not start in that folder, so it went back to the one it was on.', 'Pick another folder.'],
  'workspace-unwritable': ['P9 cannot write to this folder.', 'Change the folder, or give your user write access to this one, then Retry.'],
  'tmux-not-found': ['tmux is not installed.', 'Install it with your package manager (sudo apt install tmux, sudo dnf install tmux or sudo pacman -S tmux), then Retry. The rest of P9 works without it.'],
  'login-running': ['A sign-in is already running.', 'Finish it in your browser, or Cancel it and sign in again.'],
  'login-not-running': ['That sign-in has ended.', 'Sign in again.'],
  'no-sign-in-page': ['The sign-in has not shown its page yet.', 'Wait a few seconds, then try again.'],
  'request-refused': ['That code has characters a sign-in code never has.', 'Copy the code again from the browser and paste only the code.'],
  'shutting-down': ["P9's background service is restarting.", 'Retry in a few seconds.'],
  'settings-file-unknown': ['P9 does not know where its settings file goes.', 'Restart P9, then Retry.'],
  'settings-changed': ['Something else wrote the settings file just now.', 'Retry reads it again.'],
  'settings-invalid': ['Your settings file has an error.', 'Fix it in a text editor, or delete it, then Retry. P9 never changes a file it cannot read.'],
  'paths-required': ['This folder already has things in it, so P9 needs the paths to use.', 'Check the paths above, then Create again.'],
  'paths-invalid': ['A path is not one P9 can use.', 'Each is inside the workspace, written with / and without .. (for example docs/AGENTS.md).'],
  'settings-exist': ['A settings file appeared meanwhile, so nothing was written.', 'Retry reads it.'],
  'pick-outside': ['That is outside the workspace.', 'Pick a file or folder inside it.'],
};
function wizRender() {
  const s = W.s, steps = wizSteps(), key = steps[Math.min(W.i, steps.length - 1)], d = s ? setupDone(s) : {};
  W.i = steps.indexOf(key);
  const yes = (ok, good, bad) => `<span class="${ok ? 'ok' : 'warn'}">${ok ? '✓ ' + good : bad}</span>`;
  const btn = (act, label, variant = 'outline') => `<button data-slot="button" data-variant="${variant}" data-act="${act}"${W.busy ? ' disabled' : ''}>${label}</button>`;
  const fail = (error, detail = '') => { const [cause, fix] = WIZ_ERR[error] || ['That did not work (' + error + ').', 'Retry.']; return `<div class="wiz-fail" role="alert"><strong>${esc(cause)}</strong>${detail ? `<span class="mono sm">${esc(detail)}</span>` : ''}<span class="muted sm">${esc(fix)}</span>${btn('retry', 'Retry')}</div>`; };
  const row = (name, note, status, actions = '') => `<div class="set-row"><span><strong>${name}</strong>${note ? `<span class="muted sm">${note}</span>` : ''}</span><span class="spacer"></span>${status}${actions}</div>`;
  const note = W.note[key];
  let title, body, next = btn('next', 'Next', 'default');
  if (!s && key !== 'welcome') { title = 'Setup'; body = fail('daemon-unavailable'); }
  else if (key === 'welcome') {
    title = 'Welcome to Event Horizon'; next = btn('next', 'Start', 'default');
    body = `<p>Four checks make P9 yours: a workspace folder it can write to, an agent you are signed in to, Mission Control's starter files${s?.tmux === null ? '' : ' and the terminal'}. About five minutes.</p><p class="muted sm">Skip any time. The Set up card then waits in the Notification Center until every check passes.</p>`;
  } else if (key === 'workspace') {
    title = 'Your workspace';
    body = row('Folder', `<span class="mono" id="welWs">${esc(s.workspace)}</span>`, yes(s.writable, 'P9 can write here', 'P9 cannot write here'))
      + `<p class="muted sm">${s.workspaceEmpty ? 'It is empty; the Mission Control step adds starter files. ' : ''}Changing it restarts P9's background service: running chats, scripts and terminals stop.</p>`
      + (window.p9.workspaceChange ? `<div class="set-row">${btn('change', 'Change the folder')}</div>` : '')
      + (s.writable ? '' : fail('workspace-unwritable'))
      + (note?.error ? fail(note.error, note.detail) : '');
  } else if (key === 'agents') {
    title = 'Sign in to an agent';
    body = '<p class="muted sm">Chats run on Claude Code or Codex; at least one has to be signed in. Sign in opens your browser at its sign-in page.</p>'
      + [['claude', 'Claude', 'A Claude account. After you sign in the browser shows a code: paste it here.'], ['codex', 'Codex', 'A ChatGPT account.']].map(([a, name, sub]) => {
        const l = W.login[a] || {}, ended = !s[a] && !l.running && l.exit !== null && l.exit !== undefined;
        return row(name, sub, s[a] ? yes(true, 'Signed in') : l.running ? '<span class="muted sm">Waiting for the browser…</span>' : yes(false, '', 'Not signed in'),
          s[a] ? '' : l.running ? (l.url ? btn('open:' + a, "Browser didn't open?") : '') + btn('stop:' + a, 'Cancel') : btn('start:' + a, ended ? 'Retry' : 'Sign in', 'default'))
          + (l.running && a === 'claude' ? `<div class="set-row"><input data-slot="input" id="welCode" value="${esc(W.code)}" placeholder="Paste the code from the browser" maxlength="512" autocomplete="off" spellcheck="false" aria-label="Sign-in code">${btn('code:claude', 'Send')}</div>` : '')
          + (ended ? `<p class="warn sm">${name} sign-in ended without signing in. Retry starts it again; finish in the browser before closing it.</p>` : '')
          + (W.note[a]?.error ? fail(W.note[a].error) : '');
      }).join('');
    if (!d.agents) next = `<span class="muted sm">Sign in to one to go on, or Skip.</span>` + btn('next', 'Next', 'default').replace('<button', '<button disabled');
  } else if (key === 'mission') {
    title = 'Mission Control';
    // A folder with things in it keeps them (needs-done p9-wizard-respects-existing-workspace): the paths are what P9 found
    // there, shown and editable, and the list says exactly what Create adds. Nothing that is there is replaced.
    const choosing = wizChoosing(s), paths = wizPaths(), found = Object.keys(s.found || {}).length;
    const creates = d.mission ? [] : [...(s.creates || []), ...(s.settingsPresent ? [] : [s.settingsFile])].filter(Boolean);
    body = `<p class="muted sm">Its buttons, apps and pages come from files in your workspace. ${choosing ? (found ? 'P9 found these in your workspace and will use them; change any path first if you like.' : 'These are the paths P9 will use; change any first if you like.') : 'The paths come from your settings file.'} Nothing that is already there is replaced.</p>`
      + (choosing ? PATH_KEYS.map(([k, name, kind]) => `<label class="set-row"><span><strong>${esc(name)}</strong></span><span class="spacer"></span><input data-slot="input" class="mono" data-path="${k}" value="${esc(paths[k] || '')}" maxlength="400" autocomplete="off" spellcheck="false">${window.p9.pickFolder && kind ? btn('pick:' + k + ':' + kind, 'Pick') : ''}</label>`).join('')
        + (s.pathsInvalid ? fail('paths-invalid') : '') : '')
      + row('Settings file', `<span class="mono" id="welFile">${esc(s.settingsFile || '')}</span>`, yes(s.settings, 'Loaded', s.settingsInvalid ? 'Has an error' : s.settingsPresent ? 'Found, not loaded yet' : 'Not found'))
      + row('Starter files', 'AGENTS.md and the registry, where the settings file says', yes(s.agentsFile && s.registryFile, 'There', 'Missing'))
      + (creates.length ? `<p class="sm">Create adds: <span class="mono" data-creates>${creates.map(esc).join(', ')}</span></p>` : '')
      + (s.conflict ? `<p class="sm" data-conflict>This folder has its own files (${Object.values(s.found).map(esc).join(', ')}) that your settings file does not name. The paths above are what P9 found; change any, then Use these. Your old settings file is kept as settings.json.bak.</p>` : '')
      + (s.settingsInvalid ? fail('settings-invalid', s.settingsError) : d.mission || (choosing && s.pathsInvalid) ? '' : `<div class="set-row">${btn('starter', creates.length ? 'Create these' : 'Use these', 'default')}</div>`)
      + (note?.created?.length ? `<p class="ok sm">Created: ${note.created.map(esc).join(', ')}</p>` : '')
      + (note?.error ? fail(note.error, note.detail) : '')
      + (settings.focus.mission && (settings.focus.chat || settings.focus.dev) ? `<div class="set-row">${btn('mission-off', 'Turn Mission off for now')}</div>` : '');
  } else if (key === 'terminal') {
    title = 'Terminal';
    body = row('tmux', 'The terminal dock runs real shells in tmux.', yes(s.tmux, 'Found', 'Not found'))
      + (s.tmux ? '' : fail('tmux-not-found'));
  } else if (key === 'you') {
    title = 'You';
    body = `<label class="set-row"><span><strong>Your name</strong><span class="muted sm">The landing page greets you with it. Empty: no name.</span></span><span class="spacer"></span><input data-slot="input" id="welName" maxlength="40" autocomplete="off" spellcheck="false" value="${esc(W.name ?? settings.name ?? '')}"></label>`
      // Issue #4 item 4, option C (the owner, 2026-10-20): Skipper ships as the default; petdex.dev has more.
      + row('Pets', 'Skipper is your System pet. Find more at <a id="welPetdex" href="https://petdex.dev" target="_blank" rel="noopener">petdex.dev</a>, then add them in Settings → Pets.', '', btn('pets', 'Open Settings → Pets'));
  } else {
    title = Object.values(d).includes(false) ? 'Almost there' : 'You are set'; next = btn('tour', 'Take the tour', 'default');
    body = Object.entries(STEP_NAMES).filter(([k]) => k !== 'terminal' || s.tmux !== null).map(([k, name]) => row(name[0].toUpperCase() + name.slice(1), '', yes(d[k], 'Done', 'Not done yet'))).join('')
      + '<p class="muted sm">The tour shows each focus in about two minutes. Settings → Setup opens this again.</p>';
  }
  $('#welT').textContent = title;
  $('#welStep').textContent = `Step ${W.i + 1} of ${steps.length}`;
  morph($('#welBody'), body);
  morph($('#welFoot'), (W.i ? btn('back', 'Back') : '') + '<span class="spacer"></span>' + (key === 'done' ? btn('close', 'Close') : btn('skip', 'Skip')) + next);
}
$('#welDlg').addEventListener('input', e => { if (e.target.id === 'welCode') W.code = e.target.value; if (e.target.id === 'welName') W.name = e.target.value;
  if (e.target.dataset.path) W.paths = { ...wizPaths(), [e.target.dataset.path]: e.target.value.trim() }; });
$('#welDlg').addEventListener('change', e => { if (e.target.dataset.path) wizRefresh(); });
$('#welDlg').addEventListener('change', e => { if (e.target.id === 'welName') saveSettings({ ...settings, name: e.target.value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 40) }); });
$('#welDlg').addEventListener('click', async e => {
  if (e.target.id === 'welPetdex' && window.p9?.openPetdex) { e.preventDefault(); return window.p9.openPetdex(); }
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const [act, agent, kind] = b.dataset.act.split(':');
  const run = async (fn) => { W.busy = act; wizRender(); try { return await fn(); } finally { W.busy = ''; } };
  if (act === 'next' || act === 'back') { W.i += act === 'next' ? 1 : -1; return wizRender(); }
  if (act === 'skip' || act === 'mission-off') {
    if (act === 'mission-off') saveSettings({ ...settings, focus: { ...settings.focus, mission: false } });
    skipWelcome(); return $('#welDlg').close();
  }
  if (act === 'close') return $('#welDlg').close();
  if (act === 'tour') { W.then = tour; return $('#welDlg').close(); }
  if (act === 'pets') { W.then = null; $('#welDlg').close(); await $('#setBtn').onclick(); return [...$('#setBody').querySelectorAll('legend')].find(l => l.textContent === 'Pets')?.scrollIntoView(); }
  if (act === 'retry') W.note = {};
  if (act === 'change') {
    const r = await run(() => window.p9.workspaceChange().catch(() => ({ error: 'daemon-unavailable' })));
    W.note.workspace = r.error ? r : null;
    if (!r.error) { files.dirs = {}; renderTree(); loadMission(); } // the tree and Mission show the new folder
  }
  if (act === 'pick') {
    const picked = await window.p9.pickFolder(kind).catch(() => undefined);
    if (picked === null || picked === '') W.note.mission = { error: 'pick-outside' };
    else if (picked !== undefined) { W.paths = { ...wizPaths(), [agent]: picked }; W.note.mission = null; }
  }
  if (act === 'starter') {
    const body = wizChoosing(W.s) ? wizPaths() : {};
    const r = await run(() => liveChat.call('starter', body).catch(() => ({ status: 503, body: { error: 'daemon-unavailable' } })));
    W.note.mission = r.status === 201 ? { created: r.body.created } : { error: r.body?.error || String(r.status), detail: r.body?.detail };
    if (r.status === 201) { files.dirs = {}; renderTree(); loadMission(); }
  }
  if (['start', 'open', 'code', 'stop'].includes(act)) {
    const r = await run(() => (act === 'code' ? window.p9.agentLogin('code', agent, W.code.trim()) : window.p9.agentLogin(act, agent)).catch(() => ({ status: 503, body: { error: 'daemon-unavailable' } })));
    W.note[agent] = r.status >= 400 ? { error: r.body?.error || String(r.status) } : null;
    if (act === 'code' && r.status < 400) W.code = '';
  }
  await wizRefresh();
});
$('#welDlg').addEventListener('close', () => { clearInterval(W.timer); W.timer = 0; checkSetup(); const then = W.then; W.then = null; then?.(); });

/* ---------- live chat (phase 6) ---------- */
// With the daemon, Chat Focus shows only real ACP conversations, rebuilt from the daemon's event log (cursor 0 on
// load, then a long poll); the sample sessions go. Sends, answers and Stop go to window.p9.chat; what happened comes
// back as events, so the screen never claims something the daemon did not record.
const liveChat = { on: false, cursor: 0 };
const dataNote = () => { $('#dataNote').textContent = [live.on && 'Mission Control live', liveChat.on && 'Chat live', !liveChat.on && (sampleView ? 'Chat sample data' : 'Chat waiting for the daemon'), sampleView && 'Dev sample data'].filter(Boolean).join(' · '); };
liveChat.call = async (action, payload = {}) => {
  const body = ['list', 'events', 'lock'].includes(action) ? payload : { ...payload, op: crypto.randomUUID() };
  let r = await window.p9.chat(action, body);
  // ponytail: one retry with the same operation ID after an unanswered request; the daemon replays it or says outcome-unknown.
  if (r.status === 503 && body.op) { await new Promise(res => setTimeout(res, 1000)); r = await window.p9.chat(action, body); }
  if (r.status >= 400 && !(action === 'prompt' && r.body?.error === 'turn-running')) toast({ kind: 'chat', txt: 'Chat ' + action + ': ' + (r.body?.error || r.status), level: 'bad' }, true);
  return r;
};
liveChat.create = async (agent, folder = '') => {
  const r = await liveChat.call('create', { provider: agent, ...(folder && { folder }) });
  if (r.status === 201 && folder) try { localStorage.setItem('eh-chat-folders', JSON.stringify([folder, ...recentFolders().filter(f => f !== folder)].slice(0, 5))); } catch {}
  return r;
};
// Builder, 2026-10-21: a refused prompt puts its text back in the box as well as its images, so nothing typed is lost.
// 2026-10-24: one refused because a turn runs is queued instead, and shown and kept as queued.
liveChat.prompt = async (s, text, images = []) => { s.working = true; s.done = false; renderTabs(); renderChats(); const r = await liveChat.call('prompt', { id: s.id, text, mode: s.mode, ...(s.modelPick && { model: s.modelPick }), ...(Object.keys(s.pick || {}).length && { config: s.pick }), ...(images.length && { images: images.map(({ mimeType, data }) => ({ mimeType, data })) }) }); if (r.status === 202) return; s.images = [...images, ...(s.images || [])].slice(0, 4);
  // Refused mid-turn (an adapter without steering, or the turn ending meanwhile): queued for the turn's end, and sent a
  // second later if that end came already. ponytail: a turn that never reports its end holds it (no adapter does now).
  if (r.status === 409 && r.body?.error === 'turn-running') { s.queue.unshift(text); keepQueue(s); setTimeout(() => { if (!s.prompted && s.queue.length) turnEnd(s); }, 1000); renderChats(); return; }
  s.draft = text + (s.draft ? '\n' + s.draft : ''); s.working = false; renderTabs(); renderChats(); };
liveChat.approve = (s, optionId) => { const a = s.events.find(e => e.t === 'approval'); if (a) liveChat.call('answer', { id: s.id, request: a.request, answer: { optionId } }); };
liveChat.answer = (s, vals) => {
  const q = s.events.find(e => e.t === 'question'); if (!q || q.unsupported) return;
  const content = [];
  q.fields.forEach((f, i) => {
    const v = f.kind === 'multi' ? f.options.filter((o, j) => vals[`f${i}~${j}`] !== undefined).map(o => o[0]) : vals['f' + i] ?? '';
    // An untouched optional field is left out: no answer is not '', [] or the first choice. A text or multi field the
    // user touched sends its '' or [] as given; a choice's '' is the "No answer" option, never a value (formSpec refuses '' choices).
    const empty = v === '' || (Array.isArray(v) && !v.length);
    if (!f.required && empty && (f.kind === 'radio' || f.type === 'number' || f.type === 'integer' || !q.touched?.has('f' + i))) return;
    content.push([f.key, v === '' ? v : f.type === 'number' || f.type === 'integer' ? Number(v) : f.type === 'boolean' ? v === 'true' : v]);
  });
  liveChat.call('answer', { id: s.id, request: q.request, answer: { action: 'accept', content: Object.fromEntries(content) } });
};
liveChat.decline = s => { const q = s.events.find(e => e.t === 'question'); if (q) liveChat.call('answer', { id: s.id, request: q.request, answer: { action: 'decline' } }); };
liveChat.stop = s => { s.state = 'stopping'; renderTabs(); renderChats(); return liveChat.call('stop', { id: s.id }); };
const chatModel = { claude: 'Claude Code · ACP', codex: 'Codex · ACP' };
const toolDiff = content => { const rows = (content || []).filter(c => c.type === 'diff').flatMap(c => [...(c.oldText || '').split('\n').filter(Boolean).map(l => ['del', l]), ...(c.newText || '').split('\n').filter(Boolean).map(l => ['add', l])]).slice(0, 200); return rows.length ? rows : null; };
// Images an agent sent with their own data (threat model row 26): the type and alphabet checked again, the data: address
// built here; a block's uri is never used. ponytail: data: strings are re-diffed each render; blob: needs a CSP change.
const IMG_OK = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const imgSrc = b => b?.type === 'image' && IMG_OK.includes(b.mimeType) && typeof b.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(b.data) ? `data:${b.mimeType};base64,${b.data}` : null;
const toolImages = content => (content || []).map(c => imgSrc(c?.type === 'content' ? c.content : c)).filter(Boolean).slice(0, 4);
const agentImgs = (list, who) => list?.length ? `<div class="agent-imgs">${list.map(src => `<img src="${src}" alt="Image from ${esc(who)}">`).join('')}</div>` : '';
const toolText = content => (content || []).filter(c => c.type === 'content' && c.content?.type === 'text').map(c => c.content.text).join('\n').slice(-4000);
// A live chat's queued messages are kept per conversation, so a window restart shows them again and still sends them.
// ponytail: this window's storage only; the phone and a second desktop do not see them (a daemon-side queue would).
const keepQueue = s => { if (!s.live) return; try { s.queue.length ? localStorage.setItem('p9-queue:' + s.id, JSON.stringify(s.queue)) : localStorage.removeItem('p9-queue:' + s.id); } catch {} };
const keptQueue = id => { try { const q = JSON.parse(localStorage.getItem('p9-queue:' + id)); return Array.isArray(q) ? q.filter(t => typeof t === 'string') : []; } catch { return []; } };
const liveSession = (id, provider, title, folder, created) => ({ id, agent: provider, title, model: chatModel[provider], mode: startMode(provider), queue: keptQueue(id), effort: 'Medium', state: 'idle', pending: null, context: null, limits: { h5: 0, d7: 0 }, cacheMin: null, cwd: folder || 'P9 workspace', folder: folder || '', events: [], live: true, created });
// E2: a chat that was stopped at launch is only listed (stub); its events load the first time it is shown, or before
// the next event for it is applied. Up to until, so nothing the main loop applies comes twice; retried until it loads.
function history(s, until = liveChat.cursor) {
  return s.loading ||= (async () => {
    for (let after = 0; !lifetime.signal.aborted;) {
      const r = await window.p9.chat('events', { after, only: [s.id], until });
      // ponytail: refused (an ID that is not a UUID, which only a seeded test ledger has) leaves the chat empty, not stuck.
      if (r.status === 400) break;
      if (r.status !== 200) { await new Promise(res => setTimeout(res, 2000)); continue; }
      for (const ev of r.body.events) try { applyChat(ev); } catch {}
      after = r.body.cursor;
      if (r.body.events.length < 500) break;
    }
    s.stub = false; renderTabs(); renderChats();
  })();
}
// Applies one daemon event to S; returns the session when a turn ended (so queued messages can go).
function applyChat(ev) {
  const d = ev.data;
  if (ev.type === 'created') { if (!S.sessions.some(x => x.id === ev.conversation)) S.sessions.push(liveSession(ev.conversation, d.provider, d.title, d.folder, ev.at)); return null; }
  const s = S.sessions.find(x => x.id === ev.conversation); if (!s) return null;
  const last = s.events[s.events.length - 1], notice = text => s.events.push({ t: 'notice', text });
  const settle = () => { s.working = s.prompted = false; s.pending = null; s.events = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'); };
  switch (ev.type) {
    case 'user': s.events.push({ t: 'user', text: d.text, images: d.images, when: new Date(ev.at).toTimeString().slice(0, 5) }); s.state = 'running'; s.working = s.prompted = true; break;
    case 'connected': notice('Connected over ACP'); s.state = 'running'; break;
    case 'resumed': notice('Resumed natively (session/resume)'); s.state = 'running'; break;
    case 'config': if (Array.isArray(d.model?.options)) { s.models = lastModels[s.agent] = d.model; s.model = d.model.options.find(o => o.value === d.model.current)?.name || s.model; if (s.modelPick === d.model.current) s.modelPick = null; }
      if (Array.isArray(d.pickers)) { s.pickers = lastPickers[s.agent] = d.pickers; for (const p of d.pickers) if (s.pick?.[p.id] === p.current) delete s.pick[p.id]; } break;
    case 'update':
      // Claude Code also runs turns nobody prompted (the continuation after a compaction, a background task's report): no
      // 'user' starts them and no 'turn-end' closes them. Agent output marks the chat working; that turn's closing
      // usage_update (the one with a cost) marks it done.
      if (s.state === 'running' && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(d.sessionUpdate)) s.working = true;
      else if (d.sessionUpdate === 'usage_update' && d.cost && !s.prompted) s.working = false;
      if (d.sessionUpdate === 'agent_message_chunk' || d.sessionUpdate === 'agent_thought_chunk') {
        const t = d.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought', text = d.content?.type === 'text' ? d.content.text : '', img = t === 'agent' && imgSrc(d.content);
        if (last?.t === t) { last.text += text; if (img) (last.images ||= []).push(img); } else s.events.push({ t, text, ...(img && { images: [img] }) });
      } else if (d.sessionUpdate === 'tool_call') s.events.push({ t: 'tool', id: d.toolCallId, status: typeof d.status === 'string' ? d.status : 'pending', title: String(d.title || 'Tool call'), diff: toolDiff(d.content), output: toolText(d.content), images: toolImages(d.content) });
      else if (d.sessionUpdate === 'tool_call_update') { const tool = s.events.find(e => e.t === 'tool' && e.id === d.toolCallId); if (tool) { if (typeof d.status === 'string') tool.status = d.status; if (d.title) tool.title = String(d.title); if (d.content) { tool.diff = toolDiff(d.content); tool.output = toolText(d.content); tool.images = toolImages(d.content); } } }
      else if (d.sessionUpdate === 'available_commands_update' && Array.isArray(d.availableCommands)) s.commands = lastCommands[s.agent] = d.availableCommands.slice(0, 1000).map(c => ({ name: String(c?.name ?? ''), desc: String(c?.description ?? '') })).filter(c => c.name);
      else if (d.sessionUpdate === 'session_info_update' && typeof d.title === 'string' && d.title.trim()) s.title = d.title.replace(/\s+/g, ' ').trim().slice(0, 120);
      else if (d.sessionUpdate === 'usage_update' && d.size > 0) s.context = { used: Number(d.used) || 0, size: Number(d.size) };
      else if (d.sessionUpdate === 'plan') { const entries = (Array.isArray(d.entries) ? d.entries : []).map(x => [String(x?.status), String(x?.content ?? '')]), plan = s.events.find(e => e.t === 'plan'); if (plan) plan.entries = entries; else s.events.push({ t: 'plan', entries }); }
      break;
    case 'approval': s.events.push({ t: 'approval', request: d.request, title: d.toolCall?.title || 'Tool call', diff: toolDiff(d.toolCall?.content) || [], options: d.options.map(o => [o.optionId, o.name, o.kind]) }); s.pending = 'approval'; break;
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
    case 'restart-request': notice('The agent asks you to restart P9: ' + d.reason); break;
    case 'steer-lost': notice('This message may not have reached the agent: ' + d.text); break;
    case 'turn-end': settle(); s.lastEnd = ev.at; queueSoon(); if (d.stopReason !== 'end_turn') notice('Turn ended: ' + d.stopReason); return s;
    case 'error': s.events.push({ t: 'error', text: d.message }); s.working = false; break;
    case 'exited': settle(); s.state = 'stopped'; notice('The agent process exited' + (d.code != null ? ' (code ' + d.code + ')' : '') + '. Send again to resume.'); break;
    case 'stopped': settle(); s.state = 'stopped'; notice(d.result === 'stopped' ? 'Stopped. Everything this session started has ended.' : 'Stop could not confirm that everything ended.'); break;
    case 'interrupted': settle(); s.state = 'stopped'; notice('Interrupted: the P9 daemon restarted mid-turn. Send again to resume.'); break;
  }
  return null;
}
async function loadChat() {
  if (!window.p9?.chat) return;
  // E2: launch replays only the chats that are not stopped (a 110 MB ledger was all replayed before); the rest are
  // listed after it as stubs. ponytail: over 100 such chats it replays everything, as before (their IDs go in the URL).
  let replaying = true, scope = null;
  const list = async () => { let l; while ((l = await window.p9.chat('list', {})).status !== 200 && !lifetime.signal.aborted) await new Promise(res => setTimeout(res, 2000)); return l.body?.conversations || []; };
  while (!lifetime.signal.aborted) {
    const l = scope ? null : await window.p9.chat('list', {});
    if (l?.status === 200) { const ids = l.body.conversations.filter(c => c.state !== 'stopped').map(c => c.id); scope = ids.length <= 100 ? { only: ids } : {}; }
    const r = scope ? await window.p9.chat('events', { after: liveChat.cursor, ...(replaying ? scope : { wait: 8000 }) }) : l;
    // A refused narrowed replay (a listed ID the bridge or daemon will not take) replays everything, as before E2.
    if (r.status === 400 && replaying && scope?.only) { scope = {}; continue; }
    if (r.status !== 200) { if (!liveChat.on && sampleView) return; await new Promise(res => setTimeout(res, liveChat.on ? 2000 : 5000)); continue; }
    if (!liveChat.on) { liveChat.on = true; S.sessions = []; S.open = []; dataNote(); }
    const ended = [], answered_ = [];
    for (const ev of r.body.events) {
      const created = ev.type === 'created' && !replaying, stub = S.sessions.find(s => s.id === ev.conversation && s.stub);
      if (stub) await history(stub, ev.cursor - 1);
      // A malformed stored event is skipped, never thrown: it would fail again on every replay.
      let end = null; try { end = applyChat(ev); } catch { end = null; } if (end) ended.push(end);
      if (created) show(ev.conversation);
      if (ev.type === 'answered') answered_.push(ev.conversation);
    }
    liveChat.cursor = r.body.cursor;
    if (replaying && r.body.events.length < 500) {
      replaying = false;
      const all = await list(), have = new Map(S.sessions.map(s => [s.id, s]));
      S.sessions = [...all.map(c => have.get(c.id) || { ...liveSession(c.id, c.provider, c.title, c.folder, c.created), state: c.state, stub: true }), ...S.sessions.filter(s => !all.some(c => c.id === s.id))];
      for (const s of S.sessions) s.hidden = s.state === 'stopped' || closedChats.has(s.id);
      for (const id of closedChats) if (!S.sessions.some(s => s.id === id)) closedChats.delete(id);
      keepClosed();
      if (!S.open.length) S.open = S.sessions.filter(s => !s.hidden).slice(-2).reverse().map(s => s.id);
      // Messages kept from before a restart go now: the daemon takes them into a running turn, or queues them back.
      for (const s of S.sessions) if (s.queue.length && s.state === 'running') turnEnd(s);
    }
    else if (!replaying) { for (const s of ended) { finished(s); turnEnd(s); } for (const id of answered_) { const s = S.sessions.find(x => x.id === id); if (s && !s.pending) answered(s); } }
    renderTabs(); renderChats(new Set(r.body.events.map(ev => ev.conversation)));
  }
}

addEventListener('focus', () => renderChats());
renderMission(); renderTabs(); renderChats(); renderTree(); renderDev(); setFocus('chat', true); loadMission().then(() => setTimeout(pollMission, 20000)); pollUsage(); loadChat(); checkSetup();
addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && e.code === 'KeyN') { e.preventDefault(); mdl.open && S.modal?.kind === 'center' ? closeModal() : openModal({ kind: 'center' }); } });
// mock: the hub's two open alerts arrive a few seconds after load. Sample view only: on the daemon they filled the
// bell with test data (Builder, 2026-10-18); live notices come from loadHub.
if (!window.p9?.mission) M.notifications.forEach((n, i) => setTimeout(() => toast({ ...n }), 2500 + i * 3000));

// Anymouse: DUWOP's idea / bug / gripe box. The desktop main process sends it; the daemon files it or main opens
// GitHub's prefilled page. Only textContent here: nothing the note or GitHub returns becomes markup.
const amDlg = $('#amDlg'), amText = $('#amText'), amNote = $('#amNote'), amSend = $('#amSend'), amCount = $('#amCount');
const AM_MAX = 50000; // the daemon's limit (anymouse.mjs MAX_NOTE); a longer note stays in the box, marked, and does not send
let amKind = 'idea';
$('#amBtn').onclick = () => { amNote.textContent = ''; amCheck(); amDlg.showModal(); amText.focus(); };
$('#amClose').onclick = () => amDlg.close();
amDlg.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
  amKind = b.dataset.kind;
  amDlg.querySelectorAll('[data-kind]').forEach(x => { x.setAttribute('aria-checked', String(x === b)); x.dataset.variant = x === b ? 'default' : 'outline'; });
});
// Live counter; over the limit nothing is cut, the count turns into the message and Send waits.
const amCheck = () => {
  const n = amText.value.trim().length, over = n > AM_MAX;
  amCount.textContent = over ? n.toLocaleString('en-US') + ' / 50,000: ' + (n - AM_MAX).toLocaleString('en-US') + ' too many. Your text is kept; shorten it to send.' : n.toLocaleString('en-US') + ' / 50,000';
  amCount.classList.toggle('over', over); amText.setAttribute('aria-invalid', String(over));
  amSend.disabled = !n || over;
};
amText.oninput = amCheck;
$('#amForm').onsubmit = async (e) => {
  e.preventDefault(); amSend.disabled = true; amNote.textContent = '';
  try {
    if (!window.p9?.anymouse) throw new Error('Anymouse needs the desktop app');
    const r = await window.p9.anymouse({ kind: amKind, text: amText.value.trim(), page: S.focus });
    if (r.status !== 200) throw new Error(r.body?.error ?? "couldn't send (" + r.status + ')');
    // P9's repo is private: GitHub shows 404 to anyone not signed in with access (GitHub issue #4 item 6), so the note stays to copy.
    if (!r.body.opened) amText.value = '';
    amNote.textContent = r.body.opened ? 'Opened GitHub in your browser: finish the issue there. P9\'s repo is private, so GitHub shows "404" unless you are signed in with an account that has access. Your note is still here to copy.' + (r.body.cut ? ' It was too long for a link, so GitHub got only the start; paste the rest from here.' : '') : 'Sent as issue #' + r.body.number + '. Thanks.';
  } catch (err) { amNote.textContent = err.message; }
  finally { amCheck(); }
};

return () => { lifetime.abort(); timers.forEach(window.clearTimeout); observers.forEach(o => o.disconnect()); };
}
