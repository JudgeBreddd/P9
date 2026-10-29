import { popover as createPopover, dragBar, svg, esc, agentWarning, warnHtml, sprintTimes, limitLine, md, mdReply, info, imgSrc, toolImages, agentImgs, readImage, IMG_OK, MAX_IMAGES, modes, LOOSE, copy, copyCode } from './helpers.mjs';
// A choice is [value, label]; the sample data gives plain strings.
const opt = o => Array.isArray(o) ? o : [o, o];
import { DUWOP, shareLook } from './theme-picker';
import { WALKTHROUGH } from './walkthrough.mjs';
import { WHATS_NEW } from './whats-new.mjs';
import { chip, waiting, turnKey, lineDiff } from './composer.mjs';
import { MAINTENANCE, maintenanceGroup } from './maintenance.mjs';
import { PATH_KEYS, missionKeys, missionShown, missionValue } from './mission-files.mjs';
import { SECURITY, warnsLoose, setWarnsLoose, setStarts, unrestricted } from './security.mjs';
import { editorModal, editItems } from './mission-editor.mjs';
import { tileHtml, linkHtml, tileAnswer } from './data-tiles.mjs';
import { onboardCard, spacePicker, templateWords } from './onboarding.mjs';
import { createSky } from './landing-sky.mjs';
import { phoneDialogBody } from './phone-link.mjs';
import { pinned, applyCard } from './pinned.mjs';
import { createSide } from './side.mjs';
import { artifactView, artifactsIn, chipArtifact } from './artifact.mjs';

export function mountShell() {
// The sample data lives in the test folder and never ships (the owner, 2026-10-20: "sample data should not be in the app at all").
// Only the UI tests hand it in, through the desktop bridge (P9_SAMPLE_DATA, unpackaged only). Everywhere else the lists start
// empty and fill from the daemon (GitHub issue #4: a fresh Windows install showed the sample items, and so did a dead daemon).
const sampleView = !!window.p9?.sample;
const M = sampleView ? structuredClone(window.p9.sample) : { sessions: [], history: [], files: [], fileBody: {}, queue: [], notifications: [], inbox: [],
  audit: { run: 'none yet', ticked: 0, total: 0, contradictions: 0 }, logs: { host: '', incidents: [], rows: [] }, solo: { when: 'none yet', txt: '' },
  stats: [['Work in flight (HANDOFF.md)', 0], ['Ideas not researched', 0], ['Punch-list items', 0]], apps: [], tools: [], pages: [], scripts: {}, terminal: [], outputs: {}, space: [] };
const lifetime = new AbortController(), timers = new Set(), observers = [];
// The Sprint tracker's state (loadSprint): declared up here, as renderMission reads it.
const SP = { on: false, data: null, error: '', timer: 0 };
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
function morph(el, html) { const t = document.createElement('template'); t.innerHTML = html; sync(el, addHalos(t.content)); return el; }
// Every .fx-halo gets one ring child (builder-look.css turns it by transform, so the browser does not repaint the ring each
// frame). Added here, on each path that writes markup, so the templates stay as they were. Not read by screen readers or clicks.
function addHalos(root) {
  for (const h of [root, ...root.querySelectorAll('.fx-halo')]) if (h.matches?.('.fx-halo') && !h.querySelector(':scope > .halo')) h.insertAdjacentHTML('beforeend', '<span class="halo" aria-hidden="true"><i></i></span>');
  return root;
}
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
const setHTML = (el, html) => { if (written.get(el) !== html) { written.set(el, html); el.innerHTML = html; addHalos(el); } return el; };
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
// D2 (row 25a): Settings > New chats start in, once set, wins over the last pick; a chat's own pick does not change it.
const defaultMode = agent => { const m = localStorage.getItem('p9-mode-default:' + agent); return modes[agent].includes(m) ? m : ''; };
// A loosened last pick carries to a new chat only after "don't show again" (review #2): a plain "Turn on" was for that chat.
// The D2 default was confirmed in Settings for new chats, so it holds as set.
const startMode = agent => { const last = localStorage.getItem('p9-mode:' + agent), m = defaultMode(agent) || (!LOOSE[last] || localStorage.getItem('p9-mode-ok:' + last) ? last : ''); return modes[agent].includes(m) ? m : agent === 'codex' ? 'Auto review' : 'Auto'; };
const looseOk = (agent, m) => new Promise(done => {
  const d = $('#looseDlg'); $('#looseT').textContent = `Turn on ${m} for ${names[agent]}?`; $('#looseP').textContent = LOOSE[m]; d.returnValue = '';
  d.onclose = () => { if (d.returnValue === 'never') localStorage.setItem('p9-mode-ok:' + m, '1'); done(d.returnValue === 'yes' || d.returnValue === 'never'); };
  d.showModal();
});
const S = { sessions: structuredClone(M.sessions).map(s => ({ ...s, mode: startMode(s.agent), queue: [] })), open: sampleView ? ['s-claude-1','s-codex-1'] : [], split: false, files: false,
  focus: 'chat', termOpen: { chat: false, dev: false, mission: false }, termMode: { chat: 'float', dev: 'drawer', mission: 'float' },
  snoozed: new Set(), quiet: new Set(), setup: null, reviews: structuredClone(M.queue), alerts: [], modal: null, resume: {},
  docs: {}, dev: { tabs: [], active: null } };
// Send to server's drawing (items 24, 25; below with the black hole): pull is the pane pulled into it.
const FX = { id: null, pull: null, host: '', pct: 0, at: 0, t0: 0, raf: 0, tick: 0, drawn: 0, spin: 0, dist: 30 };
const names = { claude: 'Claude', codex: 'Codex' };
// The side panel (side.mjs). Dev Focus: the chat beside the editor (item 18), on by default, on the right until its tab is dragged across.
const side = createSide({ el: $('#side'), stage: $('.stage'), focus: () => S.focus, signal: lifetime.signal });
const chatOn = () => localStorage.getItem('eh-dan-chat:dev') !== 'off';
const sideSession = () => S.sessions.find(s => s.id === S.sideId && !s.hidden) ?? S.sessions.find(s => s.id === S.open[0]) ?? S.sessions.find(s => !s.hidden);
function renderSideChat(only) {
  const box = $('#sideChats'); if (!box || side.current()?.slot !== 'dan-chat') return;
  const s = sideSession(), pick = $('#sidePick'), list = S.sessions.filter(x => !x.hidden);
  pick.hidden = list.length < 2; pick.innerHTML = list.map(x => `<option value="${esc(x.id)}"${x.id === s?.id ? ' selected' : ''}>${esc(x.title || x.name || x.id)}</option>`).join('');
  if (!s) { box.innerHTML = '<p class="empty">No chat yet. Start one in Chat Focus.</p>'; return; }
  if (s.stub) history(s);
  paint(box, [s], only); keepBox();
}
const danChat = { title: 'Chat', focuses: ['dev'], defaultWidth: w => w / 2,
  render: b => { b.innerHTML = '<select data-slot="select" id="sidePick" aria-label="Chat shown here" hidden></select><div class="chats" id="sideChats" data-split="false"></div>'; $('#sidePick').onchange = e => { S.sideId = e.target.value; renderSideChat(); }; renderSideChat(); },
  onClose: why => { if (why === 'close') localStorage.setItem('eh-dan-chat:dev', 'off'); } };
function setSideChat(on) { localStorage.setItem('eh-dan-chat:dev', on ? 'on' : 'off'); if (on) side.open('dan-chat', danChat); else side.close('dan-chat'); }
side.onResize(() => { const on = side.current()?.slot === 'dan-chat'; $('#sideToggle').setAttribute('aria-pressed', String(on)); placeDev(); });
$('#sideToggle').onclick = () => setSideChat(side.current()?.slot !== 'dan-chat');
side.tab($('#devTab .stab'), 'main');
if (sampleView) window.__side = side; // ponytail: the UI test's door to the panel (sample data is handed in only by tests, never in a packaged build)
// Item 19 (threat model row 65): an artifact (artifact.mjs) in the side panel's 'artifact' slot, in the mode the agent
// picked; its chip in the chat reopens it. Answer 2 in specs/side-panel.md: in Dev Focus with the chat beside the
// editor it shows on top of that chat, above its text box, which stays usable. Comments go to the chat it came from,
// through the composer's own send (sendText); the composer's draft and attached images stay where they are.
const FRAME = { page: 'p9://frame/', base: new URL('frame/', location.href).href };
const ART = { state: null, mode: 'panel' };
const artSession = () => S.sessions.find(s => s.id === ART.state?.sid);
function artSend(text) {
  const s = artSession();
  if (!canSend(s, text, false)) { toast({ kind: 'comments not sent', txt: 'That chat takes no messages now.', level: 'warn' }, true); return false; }
  const images = s.images; s.images = []; sendText(s, text, false); s.images = images;
  return true;
}
const artOverlay = () => side.body.querySelector(':scope > .art-over');
function keepBox() { // the overlay ends where the side chat's text box starts
  const over = artOverlay(), b = side.body.querySelector('#sideChats .pane .bottom');
  if (over) over.style.bottom = b ? Math.max(0, side.body.getBoundingClientRect().bottom - b.getBoundingClientRect().top) + 'px' : '0px';
}
function openArtifact(art) {
  if (!ART.state || ['kind', 'src', 'sid'].some(k => ART.state.art[k] !== art[k])) ART.state = { art, sid: art.sid };
  ART.mode = art.mode ?? 'panel';
  const full = { label: 'Full screen', on: () => side.current()?.mode === 'full', go: () => side.current()?.mode === 'full' ? side.back() : side.mode('full') };
  if (S.focus === 'dev' && side.current()?.slot === 'dan-chat') {
    let over = artOverlay(); if (!over) { over = document.createElement('div'); over.className = 'art-over'; side.body.append(over); } over.replaceChildren();
    artifactView(over.appendChild(document.createElement('div')), ART.state, { ...FRAME, send: artSend, modes: [full, { label: 'Close', go: () => over.remove() }] });
    if (ART.mode === 'full') side.mode('full');
    return keepBox();
  }
  side.open('artifact', { title: art.title, mode: ART.mode, defaultWidth: w => w / 2,
    render: b => artifactView(b.appendChild(document.createElement('div')), ART.state, { ...FRAME, send: artSend, modes: [
      { label: 'Pin', on: () => ART.mode === 'pinned', go: () => { ART.mode = ART.mode === 'pinned' ? 'panel' : 'pinned'; side.mode(ART.mode); } }, full] }),
    onClose: why => { if (why !== 'replaced' && chatOn()) side.open('dan-chat', danChat); } }); // Dev Focus gets its chat back (it shows only there)
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
  const onScreen = S.focus === 'chat' ? (S.split ? S.open.slice(0, 2) : S.open.slice(0, 1)).includes(s.id) : S.focus === 'dev' && sideSession()?.id === s.id;
  if (found.length && onScreen) openArtifact({ ...found.at(-1), sid: s.id });
}
side.onResize(() => { ART.state?.refresh?.(); keepBox(); });
if (sampleView) { // the test door: an agent reply arrives whole and its turn ends (reply() streams 3 characters per 18 ms)
  const at = id => S.sessions.find(s => s.id === (id ?? (S.focus === 'dev' ? sideSession()?.id : S.open[0])));
  window.__artifact = { reply: (text, id) => { const s = at(id); s.events.push({ t: 'agent', text }); renderChats(); turnEnd(s); }, render: () => renderChats(), state: () => ART.state, events: id => at(id).events };
}
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
for (const [id, k] of [['rChat','chat'],['rDev','code'],['rMission','gauge'],['rBell','bell'],['newBtn','plus'],['stopAll','stop'],['rSearch','search'],['rFiles','files'],['rSplit','split'],['rTerm','term'],['rCmd','cmd'],['themeBtn','palette'],['setBtn','gear'],['dFloat','float'],['dHide','x'],['sideToggle','chat']]) $('#'+id).innerHTML = svg[k];

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
  if (S.setup) { const d = setupDone(S.setup), left = Object.keys(d).filter(k => !d[k] && k !== 'pick'); cards.push({ key: 'welcome', quiet: welSkipped(), n: left.length, title: `Set up · ${4 - left.length} of 4 done`, sub: left.map(k => STEP_NAMES[k]).join(' · ') }); }
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
const petSpots = JSON.parse(localStorage.getItem('p9-pet-spots') || '{}'); // 'chats:<id>' or 'mdlBody:<id>' -> { box: [x, y] }, see petHome
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
    const key = p.parentElement.id + ':' + s.id, r = p.getBoundingClientRect(), b = petBox(p);
    if (!r.width || !b) { cv.style.left = '10%'; cv.style.top = '70%'; return; }
    // A spot saved before D2 was a share of the pane: kept where it is now, from the box.
    if (Array.isArray(petSpots[key])) { petSpots[key] = { box: [r.left + petSpots[key][0] * r.width - b.left, r.top + petSpots[key][1] * r.height - b.top].map(Math.round) }; localStorage.setItem('p9-pet-spots', JSON.stringify(petSpots)); }
    const [x, y] = (IND.drag?.key === key && IND.drag.at || petSpots[key])?.box || petHome(p, cv, r, b);
    cv.style.left = Math.min(r.width, Math.max(0, b.left - r.left + x)) + 'px'; cv.style.top = Math.min(r.height, Math.max(0, b.top - r.top + y)) + 'px';
  });
  document.querySelectorAll('canvas.pet').forEach(drawPet);
}
setInterval(() => { if (!document.hidden) { IND.frame++; tickPets(); } }, 125);
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
// Drag a chat's pet within its chat; the spot is saved for that chat on release. The top bar's pets stay put.
document.addEventListener('pointerdown', e => {
  const cv = e.target.closest?.('.pane canvas.pet'); if (!cv || e.button) return;
  e.preventDefault();
  const pane = cv.closest('.pane'), where = `#${pane.parentElement.id} .pane[data-id="${CSS.escape(pane.dataset.id)}"]`;
  IND.drag = { key: pane.parentElement.id + ':' + pane.dataset.id, at: null };
  const move = ev => {
    const pane = document.querySelector(where), r = pane?.getBoundingClientRect(), b = pane && petBox(pane); if (!b) return;
    const x = Math.min(r.right, Math.max(r.left, ev.clientX)), y = Math.min(r.bottom, Math.max(r.top, ev.clientY));
    IND.drag.at = { box: [Math.round(x - b.left), Math.round(y - b.top)] };
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
  // D10: each head carries its chat's number (its place among the tabs) and the title, so several look different.
  const bots = S.sessions.filter(s => s.state === 'running' && !s.pending), say = s => names[s.agent] + ' · ' + (busy(s) ? 'working' : 'idle');
  const num = s => S.sessions.filter(x => !x.hidden).findIndex(x => x.id === s.id) + 1, label = s => (num(s) ? '#' + num(s) + ' ' : '') + s.title + ' · ' + say(s);
  setHTML($('#rBots'), bots.map(s => `<button data-slot="button" data-variant="ghost" data-size="icon" class="bot" data-bot="${esc(s.id)}" data-agent="${esc(s.agent)}"${num(s) ? ` data-n="${num(s)}"` : ''}${busy(s) ? ' data-busy' : ''} title="${esc(label(s))}" aria-label="${esc(label(s))}">${svg.bot}</button>`).join(''));
  $('#rBots').querySelectorAll('[data-bot]').forEach(b => b.onclick = () => { const k = 'run' + b.dataset.bot; openModal(S.resume[k] || { kind: 'chat', id: b.dataset.bot }, k); });
}
// The x and the body of a card: from the card itself, or from the Dev Focus overlay (main passes the clicked card's key).
function cardAct(c, what) {
  if (!c) return;
  if (c.key === 'welcome') return what === 'x' ? skipWelcome() : welcome();
  if (what === 'x') { S.snoozed.add(c.key); renderCards(); return; }
  // D10-6: a card reopens where you left it, unless that item is already handled
  const k = c.key.split(':')[0] + (c.id || ''), r = S.resume[k]; openModal(r && !(k === 'asks' && !S.sessions.find(s => s.id === r.id)?.pending) ? r : c.open, k);
}
// Dev Focus: the editor is a native view above this page, so the cards are drawn by their own overlay view (apps/desktop/cards-page.mjs).
// This page's own stack stays in the layout, hidden, so the overlay lands where the stack would be.
function cardsOverlay() {
  if (!window.p9?.cards) return;
  const cards = cardList(), r = $('#cards').getBoundingClientRect(), on = S.focus === 'dev' && cards.length > 0 && !document.querySelector('dialog[open]') && r.width > 0;
  const items = cards.slice(0, 8).map(c => ({ key: c.key.slice(0, 300), title: String(c.title).slice(0, 200), sub: String(c.sub ?? '').slice(0, 300), ...(c.n ? { n: Math.min(Number(c.n) || 0, 99999) } : {}) }));
  const next = on ? { visible: true, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), items } : { visible: false }, json = JSON.stringify(next);
  if (json === lastCards) return; // renderCards runs on every event; main hears only a change
  lastCards = json; window.p9.cards(next).catch(() => { lastCards = ''; });
}
let lastCards = '';
window.p9?.onCardAct?.(({ key, action }) => cardAct(cardList().find(c => c.key === key), action));
function renderCards() {
  renderIndicator(); renderBots();
  const cards = cardList();
  morph($('#cards'), cards.map(c => `<article class="card${c.halo ? ' fx-halo' : ''}" data-key="${esc(c.key)}"><button class="open">${c.n ? `<span class="n">${esc(c.n)}</span>` : `<span class="dot" data-agent="${esc(c.agent)}" data-live></span>`}<span class="truncate">${esc(c.title)}</span><span class="sub truncate">${esc(c.sub)}</span></button><button class="x" title="Snooze to the Notification Center">${svg.x}</button></article>`).join(''));
  $('#cards').querySelectorAll('.card').forEach((el, i) => {
    el.querySelector('.x').onclick = () => cardAct(cards[i], 'x');
    el.querySelector('.open').onclick = () => cardAct(cards[i], 'open');
  });
  cardsOverlay();
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
const sizes = { chat: [760, 620], list: [520, 460], review: [720, 640], file: [760, 560], script: [680, 560], sprint: [760, 560] }; // defaults; your resize wins, per type
const groupOf = k => ({ chat: 'chat', review: 'review', inbox: 'review', file: 'file', script: 'script', sprint: 'sprint' })[k] || 'list';
let lastEdit = null;
addEventListener('focusout', e => { const t = e.target; if (t.matches?.('textarea, input[type=text]') && !t.closest('dialog')) lastEdit = { pane: t.closest('.pane')?.dataset.id, id: t.id, sel: [t.selectionStart, t.selectionEnd] }; });
addEventListener('focusin', e => { if (!e.target.closest('dialog, .cards, .toasts, .rail') && !e.target.matches('textarea, input[type=text]')) lastEdit = null; });
// A chat opens at its newest message (Builder, 2026-10-17: it opened at the first); paint ran while the dialog was closed.
function openModal(m, card) { const seen = m.kind === 'chat' && S.sessions.find(s => s.id === m.id && s.done); if (seen) seen.done = false; m.card = card || m.card || m.back?.card; if (m.card) S.resume[m.card] = m; S.modal = m; if (m.kind === 'chat') delete view['mdlBody:' + m.id]; renderModal();
  if (!mdl.open && S.modal) { mdl.showModal(); raiseToasts(); if (m.kind === 'win') $('#mdlBody').scrollTop = winTop[m.id] || 0; } // a closed dialog ignores scrollTop
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
    liveFileModal(m, body);
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
  } else if (m.kind === 'whats-new') {
    // D13: after an update. The list ships with the app; the full list is the release commit's message.
    const w = m.w, changes = WHATS_NEW.version === w.version ? WHATS_NEW.changes : [];
    $('#mdlT').textContent = 'Updated to ' + w.version;
    body.innerHTML = `<div class="review news"><p>P9 went from ${w.from ? esc(w.from) : 'an earlier version'} to ${esc(w.version)}.${changes.length ? ' What changed:' : ''}</p>`
      + (changes.length ? '<ul>' + changes.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul>' : '') + '</div>';
    $('#mdlFoot').innerHTML = `<button data-slot="button" data-variant="outline" data-full>Full list of changes</button><span class="spacer"></span><button data-slot="button" data-variant="outline" data-dismiss>Close</button>`;
    $('#mdlFoot [data-full]').onclick = () => window.p9.openLink(w.link);
    $('#mdlFoot [data-dismiss]').onclick = () => closeModal();
  } else if (m.kind === 'alert') {
    const a = m.a; $('#mdlT').textContent = a.kind;
    body.innerHTML = `<div class="review"><span class="kind"><span class="lvl" data-l="${esc(a.level)}"></span> ${esc(a.kind)}</span><p>${esc(a.txt)}</p>${a.steps ? '<ol class="steps">' + a.steps.map(s => '<li><code>' + esc(s) + '</code></li>').join('') + '</ol><p>' + esc(a.after) + '</p>' : ''}${a.start ? '<p class="start"><b>Where to start:</b> ' + esc(a.start) + '</p>' : ''}<p class="muted sm">${a.hub ? 'From the scheduled-job and setup checks. Dismiss hides it until the next check still finds it.' : a.steps || m.done ? '' : 'In the real app this opens the check\'s log in Mission Control.'}</p></div>`;
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
function toast(a, done) {
  if (!done) S.alerts.push(a);
  const el = document.createElement('button');
  el.className = 'toast' + (a.level === 'bad' ? ' bad fx-halo' : ''); el.innerHTML = `<span class="lvl" data-l="${esc(a.level)}"></span><span class="truncate">${esc(a.txt)}</span><span class="sub">${esc(a.kind)}${done ? '' : ' · open'}</span>`; addHalos(el);
  // D1 (Builder, 2026-10-28: "if i click it, it goes away"): every toast opens its whole message, and where to start, in the panel.
  el.onclick = () => openModal({ kind: 'alert', a, done });
  el.addEventListener('animationend', e => { if (e.animationName === 'toast-out') el.remove(); });
  $('#toasts').append(el); raiseToasts(); renderCards();
}
// D7: a modal sits in the top layer over any z-index and makes the page outside it inert, so the toast list (a popover) lives
// in the topmost open modal, or the page when none is open, and is put back on top after each toast and each modal opened or
// closed anywhere (Settings, the connecting screen, a confirm): above it and clickable.
if (sampleView) window.__toast = toast; // ponytail: the UI test's door, as window.__side
const raiseToasts = () => {
  const box = $('#toasts'), into = modals.filter(d => d.matches(':modal')).pop() ?? document.body;
  if (box.parentElement !== into) into.append(box);
  if (box.children.length && box.showPopover) { box.hidePopover(); box.showPopover(); }
};
const showModal = HTMLDialogElement.prototype.showModal, modals = []; // in the order opened: the top layer's, not the page's
HTMLDialogElement.prototype.showModal = function () { showModal.call(this); modals.splice(modals.indexOf(this) >>> 0, 1); modals.push(this); raiseToasts(); };
document.addEventListener('close', e => { if (e.target instanceof HTMLDialogElement) raiseToasts(); }, true);
function focus(id) { const s = S.sessions.find(x => x.id === id); if (s?.hidden) s.hidden = false; show(id); renderTabs(); renderChats(); }
// The chat shown goes first and the one before it second, so Split has the last two (Builder, 2026-10-19: replacing only
// the first kept a one-tab start at one open chat, and Split showed one pane).
const show = id => { S.open = [id, ...S.open.filter(x => x !== id)].slice(0, 2); if (S.files) renderTree(); }; // Current project files follow the chat shown
// Tabs (Builder, 2026-10-17: 30 sessions opened on every load): a live chat gets a tab while it is not stopped; the rest
// wait in History. The x stops it on the daemon, so every window and the phone agree (owner, 2026-10-25: a new window
// reopened 9 chats closed in another). Before that, closed IDs lived in this window's localStorage: loadChat stops the
// idle ones among them once, then forgets the list.
const closedChats = new Set(JSON.parse(localStorage.getItem('eh-closed-chats') || '[]'));
// Hide steps (Builder, 2026-10-18: "where is the button to hide the commands and thinking output?"): one switch for every chat, kept across restarts.
let hideSteps = localStorage.getItem('p9-hide-steps') === '1';
function closeTab(id) {
  const s = S.sessions.find(x => x.id === id);
  if (s) s.done = false; // closing it is seeing it
  // The x stops the chat, running or idle, like closing a VS Code terminal tab (Builder, 2026-10-18; owner, 2026-10-25:
  // "hitting the x is going to make them think they closed it. like stopped it"); History reopens it.
  if (s?.live) { liveChat.stop(s, true); s.hidden = true; } else S.sessions = S.sessions.filter(x => x.id !== id);
  untab(id);
}
const untab = id => { S.open = S.open.map(o => o === id ? (S.sessions.find(x => !x.hidden && !S.open.includes(x.id)) || {}).id : o).filter(Boolean); renderTabs(); renderChats(); };
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
// History: with the daemon, every live chat a message was sent in, most recently used first (owner, 2026-10-25; Open
// gives it a tab again); without it, the sample list.
const when = at => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const liveHistory = () => S.sessions.filter(s => s.sent).sort((a, b) => (b.used || b.created) - (a.used || a.created)).map(s => { const asks = s.events.filter(e => e.t === 'user'); return `<div class="item" style="cursor:default"><span class="dot" data-agent="${esc(s.agent)}"></span><div style="min-width:0"><div class="truncate">${esc(s.title || asks[0]?.text)}</div><div class="xs muted">${names[s.agent]}${s.used || s.created ? ' · ' + esc(when(s.used || s.created)) : ''} · ${esc(s.state)}${s.stub ? '' : ` · ${asks.length} message${asks.length === 1 ? '' : 's'}`}${s.hidden ? '' : ' · in a tab'}</div></div><button data-slot="button" data-variant="outline" data-size="sm" data-open="${esc(s.id)}" style="margin-left:auto">Open</button></div>`; }).join('') || '<p class="sm muted" style="margin:6px 9px">No chats yet.</p>';
const renderHistory = () => $('#histPop').innerHTML = `<p class="sm muted" style="margin:6px 9px 10px">Close the window or quit the UI and sessions keep running. History stays here; Resume continues the provider's native session.</p>` + (liveChat.on ? liveHistory() : M.history.map(h => `<div class="item" style="cursor:default"><span class="dot" data-agent="${esc(h.agent)}"></span><div style="min-width:0"><div class="truncate">${esc(h.title)}</div><div class="xs muted">${esc(h.when)} · ${esc(h.events)} events · ${esc(h.id)}</div></div><button data-slot="button" data-variant="outline" data-size="sm" data-open="${esc(h.id)}" style="margin-left:auto">Open</button></div>`).join(''));
const histPop = popover($('#histBtn'), $('#histPop'), renderHistory);
$('#histPop').onclick = e => { const b = e.target.closest('[data-open]'); if (!b) return; if (liveChat.on) { focus(b.dataset.open); histPop.close(); return; } const h = M.history.find(x => x.id === b.dataset.open); const s = { id: 'h-' + h.id, agent: h.agent, title: h.title, model: h.agent === 'claude' ? 'Opus 5.5' : 'gpt-5.1-codex', mode: 'Manual', queue: [], effort: 'Medium', state: 'stopped', readonly: true, pending: null, context: {used: 61000, size: 200000}, limits: M.sessions[0].limits, cacheMin: null, cwd: M.sessions[0].cwd, events: [{t:'notice', text:`Older events are not shown; this view holds the latest 2,000 of ${esc(h.events)}.`}, {t:'user', text:'Finish the Phase 9 fixes and rerun the suite.', when: h.when}, {t:'tool', status:'completed', title:'Shell: pnpm test', output:'ℹ tests 51\nℹ pass 51\nℹ fail 0'}, {t:'agent', text:'Suite green. The History popover now closes on Open and the narrow toolbar scrolls instead of clipping.'}] }; if (!S.sessions.find(x => x.id === s.id)) S.sessions.push(s); show(s.id); renderTabs(); renderChats(); histPop.close(); };
DUWOP.menu($('#themePop')); popover($('#themeBtn'), $('#themePop'));

/* ---------- chats ---------- */
// CP5: each code block in a reply gets a Copy button (wire copies the code beside it).
const mdOf = e => { if (e.mdFor !== e.text) { e.md = copyCode(mdReply.parse(e.text)); e.mdFor = e.text; } return e.md; };
// Live chats: context from the agent's usage_update, 5 h and 7 d from the daemon's /usage for this agent (a reading over
// an hour old is dimmed), the cache timed from the last turn end (Claude only: its prompt cache lasts an hour).
// One limit window as a bar (chat meters and Mission's Usage panel); an expired window shows a dash.
// Amber from 75% on every bar (MR1).
const HOT = 75;
const meterBar = (label, w, line, now = Date.now()) => { const p = !w || w.resetsAt && w.resetsAt < now ? null : Math.round(w.usedPercent); return `<div class="meter" title="${esc(line.text)}"${line.stale ? ' data-stale' : ''}><div class="l"><span>${label}</span><b>${p == null ? '—' : p + '%'}</b></div><div class="fx-meter" ${p >= HOT ? 'data-hot' : ''}><span style="width:${p || 0}%"></span></div></div>`; };
// The same reading as a ring (Mission's Usage card and dialog); the label comes first in the markup and is drawn under the ring.
const ringMeter = (label, w, line, now = Date.now()) => { const p = !w || w.resetsAt && w.resetsAt < now ? null : Math.round(w.usedPercent); return `<div class="uring" title="${esc(line.text)}"${line.stale ? ' data-stale' : ''}><span class="lbl">${label}</span><div class="ring" role="img" aria-label="${esc(label)} ${p == null ? 'no reading' : p + '%'}" style="--p:${Math.min(p || 0, 100)}" ${p >= HOT ? 'data-hot' : ''}><b>${p == null ? '—' : p + '%'}</b></div></div>`; };
const usageRings = () => { const now = Date.now(); return Object.keys(names).filter(a => usage.limits?.[a]).map(a => { const lim = usage.limits[a], line = limitLine(names[a], lim, now); return `<div class="uagent"><b>${names[a]}</b>${ringMeter('5 h', lim.fiveHour, line, now)}${ringMeter('Week', lim.sevenDay, line, now)}</div>`; }).join(''); };
// The cache clock: text and state, so the 15 s tick can move it without rebuilding the pane.
const cacheOf = s => {
  const cacheMin = !s.live ? s.cacheMin : s.agent === 'claude' && s.lastEnd ? Math.floor((Date.now() - s.lastEnd) / 60000) : null;
  const left = cacheMin == null ? null : 60 - cacheMin;
  return left == null ? ['—', ''] : left <= 0 ? ['cold', 'cold'] : [left + ' min', left < 20 ? 'cooling' : 'warm'];
};
function meters(s) {
  const ctx = s.context ? Math.round(s.context.used / s.context.size * 100) : null;
  const lim = s.live ? usage.limits?.[s.agent] : { fiveHour: { usedPercent: s.limits.h5 * 100 }, sevenDay: { usedPercent: s.limits.d7 * 100 }, asOf: Date.now() };
  const line = limitLine(names[s.agent], lim), now = Date.now();
  const bar = (label, w) => meterBar(label, w, line, now);
  const cache = cacheOf(s);
  return `<div class="meters">
    <div class="meter" title="${esc(ctx == null ? 'No context size reported by this agent yet' : s.context.used.toLocaleString() + ' of ' + s.context.size.toLocaleString() + ' tokens')}"><div class="l"><span>Context</span><b>${ctx == null ? '—' : ctx + '%'}</b></div><div class="fx-meter" ${ctx >= HOT ? 'data-hot' : ''}><span style="width:${ctx || 0}%"></span></div></div>
    ${bar('5 h', lim?.fiveHour)}
    ${bar('7 d', lim?.sevenDay)}
    <div class="cache" data-s="${cache[1]}" title="How long the agent still has this chat saved for a cheaper next message (the 1-hour prompt cache, counted from its last output)">${svg.clock}${cache[0]}</div>
  </div>`;
}
// CP3: a sent photo comes back from the daemon by hash, once; until then (or once pruned) its tile stays blank.
const chatImgs = new Map();
const loadImg = (s, hash) => { if (chatImgs.has(hash) || !s.live) return; chatImgs.set(hash, '');
  window.p9.chat('image', { id: s.id, hash }).then(r => { if (r.status === 200) { chatImgs.set(hash, `data:${esc(r.body.mimeType)};base64,${esc(r.body.data)}`); renderChats(new Set([s.id])); } else if (r.status !== 404) chatImgs.delete(hash); }); };
function event(e, s) {
  switch (e.t) {
    case 'user': return `${Array.isArray(e.images) ? `<div class="user-imgs">${e.images.map(i => `<img data-chat-img="${esc(i.hash)}"${chatImgs.get(i.hash) ? ` src="${chatImgs.get(i.hash)}"` : ''} alt="Sent image">`).join('')}</div>` : ''}<div class="msg user"><div class="who">You${e.when ? ' · ' + esc(e.when) : ''}</div>${esc(e.text)}${e.images ? `<div class="xs muted" style="margin-top:6px">📎 ${esc(e.images.length ?? e.images)} image${(e.images.length ?? e.images) > 1 ? 's' : ''}</div>` : ''}</div>`;
    case 'agent': return `<div class="msg agent"><div class="who">${names[s.agent]}</div>${mdOf(e)}${agentImgs(e.images, names[s.agent])}</div>`;
    case 'warn': return warnHtml(e.text, ' data-ev="' + s.events.lastIndexOf(e) + '"' + (e.open ? ' open' : ''));
    case 'thought': return `<details class="thought" data-ev="${s.events.lastIndexOf(e)}"${e.open ? ' open' : ''}><summary>Thinking</summary><p>${esc(e.text)}</p></details>`;
    case 'tool': return `<details class="tool" data-ev="${s.events.lastIndexOf(e)}"${(e.open ?? e.status === 'in_progress') ? ' open' : ''}><summary><span class="chev">${svg.chev}</span><span data-slot="badge" data-variant="${e.status === 'completed' ? 'ok' : e.status === 'failed' ? 'bad' : 'primary'}">${esc(e.status.replace('_',' '))}</span><span class="ttl truncate">${esc(e.title)}</span></summary>${e.diff ? diff(e.diff) : ''}${e.output ? `<pre>${esc(e.output)}</pre>` : e.status === 'in_progress' ? '<pre class="caret"></pre>' : ''}</details>${e.plan ? `<button data-slot="button" data-variant="outline" data-size="sm" class="open-plan" data-open-plan="${s.events.lastIndexOf(e)}">Open plan</button>` : ''}${agentImgs(e.images, names[s.agent])}`;
    case 'notice': return `<div class="notice">${esc(e.text)}${e.restart && window.p9?.restartService ? ' <button data-slot="button" data-variant="outline" data-size="sm" data-restart-p9>Restart P9</button>' : ''}</div>`;
    case 'error': return `<div class="notice" style="color:var(--destructive)">${esc(e.text)}${/^(Claude Code|Codex) is not signed in on this computer\./.test(e.text) && window.p9?.agentLogin ? ' <button data-slot="button" data-variant="outline" data-size="sm" data-signin>Sign in</button>' : ''}</div>`;
  }
  return '';
}
const diff = rows => `<div class="diff">${rows.map(([k, l]) => `<div class="${esc(k)}">${k === 'add' ? '+' : k === 'del' ? '−' : ' '} ${esc(l)}</div>`).join('')}</div>`;
function pending(s) {
  if (s.pending === 'approval') { const a = s.events.find(e => e.t === 'approval'); return `<div class="pending fx-halo" role="group" aria-label="Approval"><div class="eyebrow">Approval needed</div><h4>${esc(a.title)}</h4>${diff(a.diff)}${a.plan ? `<button data-slot="button" data-variant="outline" data-size="sm" data-open-plan="${s.events.indexOf(a)}">Open plan</button>` : ''}${s.live ? '<p class="hint">Sending a message declines this and sends the message instead.</p>' : ''}<div class="acts">${a.options.map(([k, l, kind]) => `<button data-slot="button" data-variant="${(kind || k).startsWith('reject') ? 'outline' : 'default'}" data-size="sm" class="fx-lift" data-approve="${esc(k)}">${esc(l)}</button>`).join('')}</div></div>`; }
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
  return (from || s.more !== undefined ? `<button data-slot="button" data-variant="ghost" data-size="sm" class="earlier" data-earlier>Show earlier${from ? ` (${from.toLocaleString()} more)` : ''}</button>` : '')
    + list.slice(from).map(e => event(e, s)).join('');
}
function pane(s, i, bare) {
  const working = busy(s);
  // D14: a chat on its way to the server, or gone there, takes no messages here.
  const away = s.state === 'moving' || s.state === 'moved', frozen = s.readonly || away;
  const stateLabel = { running: 'Running', stopped: s.readonly ? 'Read-only · history' : 'Stopped', idle: 'Not started', stopping: 'Stopping…', moving: 'Moving to the remote…', moved: 'Moved to ' + (s.movedTo || 'the remote') }[s.state];
  const body = s.stub ? '<div class="welcome"><p>Loading this chat…</p></div>' : s.events.length === 0 ?`<div class="welcome"><span class="dot" data-agent="${esc(s.agent)}" data-live></span><h2 class="fx-title">What are we working on?</h2><p>${names[s.agent]} · ${esc(s.cwd)}</p><div class="chips"><span data-slot="badge">${esc(s.model)}</span><span data-slot="badge">${esc(s.mode)}</span></div>${s.live ? '<p data-start-hint>Type your first message below to start.</p>' : `<button data-slot="button" data-variant="secondary" style="margin-top:8px" data-start>Start ${names[s.agent]} chat</button>`}</div>`
    : `<div class="col">${shown(s)}${pending(s)}</div>`;
  const pick = s.modeNext || s.mode;
  return `<section class="pane${i === 0 && S.split ? ' focus' : ''}" data-id="${esc(s.id)}"${hideSteps ? ' data-quiet' : ''}${FX.pull === s.id ? ' data-pulled' : ''} aria-label="${names[s.agent]} chat">
    <div class="ptool"><span class="dot" data-agent="${esc(s.agent)}" ${s.state === 'running' ? 'data-live' : ''}></span><span class="name">${names[s.agent]}</span>
      <select data-slot="select" aria-label="Mode" data-mode>${modes[s.agent].map(m => `<option${m === pick ? ' selected' : ''}>${m}</option>`).join('')}</select>${s.modeNext ? `<span class="mode-q" title="Applies when this turn ends">queued</span>` : ''}
      <select data-slot="select" aria-label="Model" data-model>${modelOpts(s)}</select>
      ${pickerSelects(s)}
      <button data-slot="button" data-variant="ghost" data-size="sm" data-steps aria-pressed="${hideSteps}" title="Shows or hides the agent's tool calls and thinking in this chat">${hideSteps ? 'Show steps' : 'Hide steps'}</button>
      ${s.live ? `<button data-slot="button" data-variant="ghost" data-size="sm" data-phone title="Open this chat on your phone">Phone</button>` : ''}
      <span class="state" data-s="${esc(s.state)}">${stateLabel}</span>
      ${s.state === 'running' ? `<button data-slot="button" data-variant="ghost" data-size="sm" data-stop>Stop</button>` : s.state === 'stopped' ? `<button data-slot="button" data-variant="outline" data-size="sm" data-resume>Resume</button>` : ''}
      ${s.live && s.agent === 'claude' && s.session && !away ? `<button data-slot="button" data-variant="ghost" data-size="sm" data-handoff title="Continue this session in Claude Code Remote Control (claude.ai or the Claude app): stops it here and types the command into a terminal">Hand off</button>` : ''}
      ${s.live && s.session && s.state !== 'moved' && window.p9?.sendToServer && !serverInfo?.host
        ? `<button data-slot="button" data-variant="ghost" data-size="sm" data-send-away ${s.state === 'moving' ? '' : busy(s) ? 'disabled ' : ''}title="${s.state === 'moving' ? 'The move did not finish: press to finish it' : busy(s) ? 'Finish or stop the turn first' : 'Move this chat to ' + esc(serverInfo?.last || 'your remote (Settings > Remote)') + ' and carry on there: it stops here, and the remote picks it up where it left off'}">Send to remote</button>` : ''}
      ${bare ? '' : `<button data-slot="button" data-variant="ghost" data-size="icon-sm" title="Close" data-close>${svg.x}</button>`}</div>
    <div class="hist">${body}</div>
    <div class="bottom"><div class="col">${pinned(s, mdOf)}${working ? `<div class="working"><span class="glyph" aria-hidden="true">${IND.glyphs[IND.frame % IND.glyphs.length]}</span>${names[s.agent]} is working…</div>` : ''}${s.readonly ? '' : meters(s)}
      ${s.queue.length || s.held?.length ? `<div class="queue">${waiting(s)}${s.queue.map((q, j) => `<div class="q"><span>Queued: ${esc(q)}</span><button title="Interrupt and send this now" data-qnow="${j}">${svg.bolt}</button><button title="Remove from the queue" data-qdel="${j}">${svg.x}</button></div>`).join('')}</div>` : ''}
      <div class="composer"><div class="slash" data-slash hidden></div>${s.images?.length ? `<div class="attach">${s.images.map((im, i) => `<span class="att"><img src="data:${im.mimeType};base64,${im.data}" alt="${esc(im.name)}" title="${esc(im.name)}"><button data-unattach="${i}" title="Remove" aria-label="Remove ${esc(im.name)}">×</button></span>`).join('')}</div>` : ''}<textarea placeholder="${s.state === 'moved' ? 'This chat carries on at ' + esc(s.movedTo || 'the remote') + ': open it there (the title-bar badge switches to it)' : s.state === 'moving' ? 'Moving to the remote…' : s.readonly ? 'Resume this conversation to send' : s.state === 'idle' ? 'Start a chat to send' : 'Message ' + names[s.agent] + '…'}" rows="2" ${frozen ? 'disabled' : ''}>${esc(s.draft || '')}</textarea><div class="bar">${working && !frozen ? chip() : '<span class="hint">Shift Enter · new line / for commands</span>'}<span class="spacer"></span><button data-slot="button" data-variant="ghost" data-size="icon-sm" title="Attach image (max 4)" data-attach>${svg.clip}</button><button data-slot="button" data-size="icon-sm" class="send" ${frozen ? 'disabled ' : ''}title="${working ? 'Steer (Enter). Ctrl click interrupts and sends' : 'Send'}" data-send>${svg.send}</button></div></div></div></div>
  </section>`;
}
// Panes are rebuilt from S on every change (streaming replies re-render every 18 ms), so the
// state a person owns lives in S or is carried across: draft in s.draft, images in s.images,
// tool/thinking open state in the event, scroll + caret captured here. A pane at the bottom stays pinned to it.
const bottoms = observe(() => $('.stage').style.setProperty('--chat-bottom', Math.max(0, ...[...$('#chats').querySelectorAll(':scope > .pane > .bottom')].map(b => b.offsetHeight)) + 'px')); // Chat Focus full: the artifact ends above the text box
const wiredBars = new WeakSet(), view = {}; // 'container:session id' -> { top, pinned, selection }
// only: the chat ids a daemon batch touched; the other panes shown are left as they are.
function renderChats(only) {
  const ids = S.split ? S.open.slice(0, 2) : S.open.slice(0, 1);
  const ss = ids.map(id => S.sessions.find(s => s.id === id)).filter(Boolean);
  if (document.hasFocus()) { const seen = [...(S.focus === 'chat' ? ss : []), mdl.open && S.modal?.kind === 'chat' && S.sessions.find(s => s.id === S.modal.id)].filter(s => s?.done); seen.forEach(s => { s.done = false; }); if (seen.length) renderCards(); }
  $('#chats').dataset.split = String(S.split && ss.length > 1);
  for (const s of [...ss, mdl.open && S.modal?.kind === 'chat' && S.sessions.find(x => x.id === S.modal.id)]) if (s?.stub) history(s);
  paint($('#chats'), ss, only);
  bottoms.disconnect(); $('#chats').querySelectorAll(':scope > .pane > .bottom').forEach(b => bottoms.observe(b));
  if (mdl.open && S.modal?.kind === 'chat') paint($('#mdlBody'), [S.sessions.find(s => s.id === S.modal.id)].filter(Boolean), only);
  renderSideChat(only);
  if (side.current()?.slot === 'artifact' && ART.mode === 'panel' && S.focus === 'chat' && ![...ids, mdl.open && S.modal?.kind === 'chat' && S.modal.id].includes(ART.state?.sid)) side.close('artifact'); // item 19: a panel artifact goes with its chat; a pinned one stays
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
  if (part) panes.forEach(p => { const i = old.indexOf(p), t = document.createElement('template'); t.innerHTML = pane(ss[i], i, bare); addHalos(t.content); attrs(p, t.content.firstElementChild); sync(p, t.content.firstElementChild); });
  else morph(root, ss.map((s, i) => pane(s, i, bare)).join('<div class="handle-v" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize the two chats (arrow keys)"></div>'));
  const split = root.id === 'chats' && root.querySelector(':scope > .handle-v'); // morph keeps the bar by position; wire it once
  if (split && !wiredBars.has(split)) { wiredBars.add(split); dragBar(split, { axis: 'x', get: () => root.querySelector('.pane').offsetWidth, set: px => root.style.setProperty('--split-l', px + 'px'), min: 280, max: () => root.clientWidth - 281, signal: lifetime.signal }); }
  (part ? panes : root.querySelectorAll('.pane')).forEach(p => {
    const s = S.sessions.find(x => x.id === p.dataset.id), h = p.querySelector('.hist'), v = view[root.id + ':' + s.id];
    const place = () => h.scrollTo({ top: !v || v.pinned ? 1e6 : v.top, behavior: 'instant' });
    place(); if (!v) document.fonts.ready.then(() => requestAnimationFrame(place)); // first paint: late font swap leaves it short of the bottom
    p.querySelectorAll('details[data-ev]').forEach(d => d.ontoggle = () => { s.events[d.dataset.ev].open = d.open; });
    p.querySelectorAll('img[data-chat-img]:not([src])').forEach(img => loadImg(s, img.dataset.chatImg));
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
    if (caret && caret.id === s.id) { const c = caret.n ? p.querySelector(`[data-question] [name="${caret.n}"]`) : ta; if (c) { c.focus(); c.setSelectionRange(caret.s, caret.e); } else ta.focus(); } // CP9: the answered question's field is gone
    // note 8: while a turn runs, Enter queues the message; Ctrl Enter (or Ctrl click) interrupts and sends it now.
    // 2026-10-24: a live chat sends at once, and the daemon puts it into the running turn; it queues only behind messages
    // already queued, or when the daemon refuses it mid-turn (liveChat.prompt).
    // CP1: mid-turn, when says how (composer.mjs): Enter or Steer steers it in after the current step, Tab or Queue sends it after the turn.
    const go = (now, when) => { const t = ta.value.trim(); if (!canSend(s, t, now)) return; s.draft = ''; sendText(s, t, now, when); if (bare && settings.closeOnSend) closeModal(); };
    const stopTurn = () => { cancelTurn(s); renderTabs(); renderChats(); };
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
    p.querySelectorAll('[data-restart-p9]').forEach(b => b.onclick = () => restartP9(b));
    // PH5: the daemon stops the chat and opens a terminal with the command typed in; the dock shows that terminal.
    p.querySelectorAll('[data-handoff]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      const r = await liveChat.call('handoff', { id: s.id });
      if (!r.body?.terminal) { if (r.body?.command) { s.events.push({ t: 'notice', text: 'The terminal did not open. Run this in a terminal in the chat folder to continue: ' + r.body.command }); renderChats(); } b.disabled = false; return; }
      showTerminal(r.body.terminal);
    });
    // D14: main moves the chat over its own tunnel (desktop/move.mjs); the moving, moved and move-failed events say how it went.
    p.querySelectorAll('[data-send-away]').forEach(b => b.onclick = async () => { b.disabled = true; await sendAway(s); b.disabled = false; });
    // D7: "not signed in" opens the setup wizard at its agents step (browser sign-in, or sign-in in a P9 terminal).
    // Item 15: by name (the pick step now comes first), with the chat's own agent on the step even when it was not picked.
    p.querySelectorAll('[data-signin]').forEach(b => b.onclick = () => welcome('agents', /^Codex/.test(b.parentElement.textContent) ? 'codex' : 'claude', true));
    p.querySelectorAll('[data-copycode]').forEach(b => b.onclick = () => copy(b.nextElementSibling.textContent, b));
    p.querySelectorAll('[data-artifact]').forEach(b => b.onclick = () => openArtifact({ ...chipArtifact(b), sid: s.id }));
    p.querySelectorAll('[data-open-plan]').forEach(b => b.onclick = () => openPlan(s, b.dataset.openPlan));
    p.querySelectorAll('[data-unhold]').forEach(b => b.onclick = () => liveChat.call('unhold', { id: s.id, held: b.dataset.unhold }));
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
    const more = p.querySelector('[data-earlier]'); if (more) more.onclick = async () => {
      if (s.fetching) return;
      const h = p.querySelector('.hist'), below = h.scrollHeight - h.scrollTop;
      if (s.more !== undefined && s.events.filter(e => e.t !== 'approval' && e.t !== 'question').length < (s.tail || TAIL) + TAIL) { s.fetching = true; try { await earlier(s); } finally { s.fetching = false; } }
      s.tail = (s.tail || TAIL) + TAIL; renderChats(); h.scrollTop = h.scrollHeight - below;
    };
    const st = p.querySelector('[data-start]'); if (st) st.onclick = () => { s.state = 'running'; s.events.push({t:'notice', text:'Connected over ACP · ' + s.model}); renderTabs(); renderChats(); };
    const stop = p.querySelector('[data-stop]'); if (stop) stop.onclick = () => { if (s.live) return liveChat.stop(s); cancelTurn(s, true); s.state = 'stopped'; s.pending = null; s.events = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'); s.events.push({t:'notice', text:'Stopped. Resume continues the native session.'}); renderTabs(); renderChats(); };
    const res = p.querySelector('[data-resume]'); if (res) res.onclick = () => { if (s.live) return p.querySelector('textarea').focus(); s.state = 'running'; s.readonly = false; s.events.push({t:'notice', text:'Resumed natively (session/resume).'}); renderTabs(); renderChats(); };
    p.querySelector('[data-steps]').onclick = () => { hideSteps = !hideSteps; localStorage.setItem('p9-hide-steps', hideSteps ? '1' : '0'); renderChats(); };
    const cl = p.querySelector('[data-close]'); if (cl) cl.onclick = () => closeTab(s.id);
    const ph = p.querySelector('[data-phone]'); if (ph) ph.onclick = () => continueOnPhone(s);
  });
}
function answered(s) {
  if (mdl.open && S.modal?.kind === 'chat' && S.modal.id === s.id) closeModal();
  renderTabs(); renderChats(new Set([s.id]));
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
    if ((s.images ||= []).length >= MAX_IMAGES) { toast({ kind: 'not attached', txt: 'Four images a message at most.', level: 'warn' }, true); break; }
    try { s.images.push(await readImage(file)); }
    catch (e) { toast({ kind: 'not attached', txt: file.name + ': ' + (e?.message || e) + '.', level: 'warn' }, true); }
  }
  renderChats();
}
// The composer's send (go) and an artifact's Send comments (item 19) share it: queued behind a running turn, or sent.
const canSend = (s, t, now) => !!s && !((!t && !(s.images?.length && (!busy(s) || now))) || s.readonly || s.state === 'moving' || s.state === 'moved');
function sendText(s, t, now, when) {
  const mid = !now && busy(s);
  if (!now && (s.live ? s.queue.length : busy(s))) { s.queue.push(t); keepQueue(s); renderChats(); return; }
  (now ? interrupt : startTurn)(s, t, mid ? when || 'steer' : undefined);
}
function startTurn(s, t, when) {
  const images = s.images || []; s.images = [];
  if (s.live) return liveChat.prompt(s, t, images, when);
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
  // CP7: no turn to cancel (it ended, or its end never came) means idle: the chat stops showing working and an
  // interrupt's message, queued first, goes now.
  if (s.live) { if (!quiet) liveChat.call('cancel', { id: s.id }).then(r => { if (r.status === 409 && r.body?.error === 'no-turn') { s.working = s.prompted = false; turnEnd(s); } }); return; }
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
  autoArtifact(s);
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
    $('#xferBtn').hidden = !window.p9?.xferPlan || !!serverInfo?.host;
    $('#xferBtn').title = 'Copy ' + (root || 'the workspace') + ' to the same folder on ' + (serverInfo?.last || 'your remote (Settings > Remote)') + ' over P9\'s own tunnel: no Syncthing. It asks before writing over anything.';
    return;
  }
  $('#tree').innerHTML = tree(M.files, 0, q, S.modal?.kind === 'file' && mdl.open ? S.modal.name : null);
  $('#tree').querySelectorAll('[data-file]').forEach(b => b.onclick = () => openModal({ kind: 'file', name: b.dataset.file }));
}
// Send files (item 23; main's p9:xfer, desktop/xfer.mjs): the files panel's folder goes to the same folder on the server.
// Main plans and keeps the plan; this asks what the plan cannot settle alone (Builder, 2026-10-27: one choice for the whole
// list; a delete is asked; a Syncthing folder warns; a limit names its Setting), then shows the send. A plan with nothing
// to ask sends at once: one button press.
const XFER_SETTINGS = { fileMiB: ['Largest file to send', 'MiB', 65536], files: ['Most files in one send', 'files', 200000], sendGiB: ['Most data in one send', 'GiB', 1024] }; // desktop/xfer.mjs XFER_LIMITS
const bytes = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GiB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MiB' : Math.ceil(n / 1024) + ' KiB';
const xfer = { id: null };
window.p9?.onXfer?.(p => { if (p.id !== xfer.id || !$('#xferDlg').open) return; const bar = $('#xferBar'); if (bar) { bar.max = p.total || 1; bar.value = p.sent; $('#xferNum').textContent = bytes(p.sent) + ' of ' + bytes(p.total); } });
function xferShow(title, note, body, foot) {
  $('#xferT').textContent = title; $('#xferP').textContent = note; $('#xferBody').innerHTML = body; $('#xferFoot').innerHTML = foot;
  if (!$('#xferDlg').open) $('#xferDlg').showModal();
}
const xferClose = '<button data-slot="button" data-variant="outline" data-xfer-close>Close</button>';
function xferWire() { $('#xferDlg').querySelectorAll('[data-xfer-close]').forEach(b => b.onclick = () => { xfer.id = null; $('#xferDlg').close(); }); }
// A refusal: a limit links its Setting.
function xferRefused(r) {
  xferShow('Not sent', r.message || r.error || 'No answer.', '', (r.setting ? '<button data-slot="button" data-variant="default" id="xferSetting">Open Settings</button>' : '') + xferClose);
  xferWire();
  if (r.setting) $('#xferSetting').onclick = async () => { $('#xferDlg').close(); await $('#setBtn').onclick(); const input = $('#setXfer-' + r.setting); input?.scrollIntoView({ block: 'center' }); input?.focus(); };
}
async function sendFiles() {
  const folder = fileRoot(), b = $('#xferBtn');
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
  $('#xferDlg').querySelectorAll('[data-xfer-choice]').forEach(c => c.onclick = () => go(c.dataset.xferChoice === 'go' ? null : c.dataset.xferChoice, !!$('#xferDel')?.checked));
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
  files.dirs = {}; renderTree();
}
$('#xferBtn').onclick = sendFiles;
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
  edSave = { root, save, after };
}
// D7: Ctrl+S saves the editor on screen wherever the focus is in its window: a Save click re-renders the modal and drops the
// focus to the page, which used to leave Ctrl+S doing nothing at all.
let edSave = null;
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's' || !edSave?.root.isConnected) return;
  const host = edSave.root.closest('dialog') || edSave.root, at = document.activeElement;
  if (!host.checkVisibility() || (at && at !== document.body && !host.contains(at))) return; // a closed modal never saves
  e.preventDefault(); edSave.save(); edSave.after();
});
// D7: why a save failed, in words; the daemon's code word stays at the end for a bug report.
function saveWhy(r) {
  const code = r.body?.error || r.body?.code || String(r.status);
  const words = { 'registry-read-only': 'P9 keeps this file read-only (it holds Mission Control button commands)',
    'request-refused': 'P9 refused it: a locked or protected name, or not a text file',
    'daemon-unavailable': 'P9' + (serverInfo?.host ? ' on ' + serverInfo.host : '') + ' did not answer; check the connection and try again',
    'daemon-outdated': 'P9' + (serverInfo?.host ? ' on ' + serverInfo.host : '') + ' is older than this app; update it, then try again',
    EACCES: 'no permission to write it', EPERM: 'no permission to write it', EROFS: 'the disk is read-only', ENOSPC: 'the disk is full',
    EDQUOT: 'the disk quota is full', EBUSY: 'the file is busy; try again', ENOENT: 'its folder is gone' }[code];
  return (words || 'P9 could not write it') + ' (' + code + ')';
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
// The chat meters read usage.limits: fetched again each minute, and at once when Claude reports its limits or any turn
// ends (Codex writes its limits to its session log each turn). The cache clock moves on every 15 s without a re-render.
const pollUsage = () => { loadUsage().then(renderChats); setTimeout(pollUsage, 60000); };
let usageSoon = 0;
// Panes are redrawn only when the figures moved, so a turn end in one chat does not rebuild the others (E2).
const usageNow = () => { clearTimeout(usageSoon); usageSoon = setTimeout(() => { const was = JSON.stringify(usage.limits); loadUsage().then(() => { if (JSON.stringify(usage.limits) !== was) renderChats(); }); }, 300); };
setInterval(() => { if (document.hidden) return; for (const s of S.sessions) for (const el of document.querySelectorAll('.pane[data-id="' + s.id + '"] .cache')) { const [text, state] = cacheOf(s); el.dataset.s = state; el.lastChild.textContent = text; } }, 15000);
// Restart P9's background service (finding 6): the one way back for a service that hangs or lost a file, from the Mission
// notes and Settings. Main asks first, and restarts a service that does not answer at all. RS1: main answers once the new
// service answers, or says why not. repair (MT1): set the service up again first. button: none from Ctrl K.
const restartBtn = () => (window.p9?.restartService ? ' <button data-slot="button" data-variant="outline" data-restart-btn>Restart P9</button>' : '');
async function restartP9(button, repair) {
  if (button) button.disabled = true;
  const r = await (repair ? window.p9.repairService() : window.p9.restartService()).catch(() => ({ error: (repair ? 'repair' : 'restart') + '-failed' }));
  if (button) button.disabled = false;
  if (r.cancelled) return;
  const done = repair ? 'repaired' : 'restarted';
  toast({ kind: r.restarted ? done : 'not ' + done, txt: r.restarted ? 'P9 ' + done + '.' : WIZ_ERR[r.error]?.join(' ') ?? 'Could not ' + (repair ? 'repair' : 'restart') + ' P9 (' + r.error + (r.detail ? ': ' + r.detail : '') + ')', level: r.restarted ? 'ok' : 'bad' }, true);
  if (r.restarted) loadMission();
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
  renderMission(); renderTabs(); loadHub(); loadArt(); loadSprint();
}
// Sprint tracker: the button shows while the connected machine has a sprint status file (the sprint skill writes it each
// wake-up). 404 = no sprint; any other answer keeps the button and the window says why.
async function loadSprint() {
  clearTimeout(SP.timer);
  const r = await window.p9.mission('sprint').catch(() => ({ status: 503 }));
  if (lifetime.signal.aborted) return;
  const on = r.status !== 404 && r.status !== 503, before = JSON.stringify([SP.on, SP.data]);
  SP.on = on; SP.data = r.status === 200 ? r.body : null; SP.error = on && r.status !== 200 ? (r.body?.reason || r.body?.error || String(r.status)) : '';
  if (before !== JSON.stringify([SP.on, SP.data])) renderMission(); // the tile shows merged/total
  if (mdl.open && S.modal?.kind === 'sprint') { if (on) renderModal(); else closeModal(); }
  SP.timer = setTimeout(loadSprint, 30000);
}
const SPRINT_STATE = { running: 'running', waiting: 'waiting', merged: 'merged', blocked: 'blocked', unknown: 'unknown' };
const sprintOverall = d => Number.isFinite(d.overall) ? `<div class="spall"><div class="ring" role="img" aria-label="Whole sprint ${d.overall}%" style="--p:${d.overall}" data-overall><b>${d.overall}%</b></div><div class="spt"><b>Whole sprint</b><span class="sm muted">${d.chunks.filter(c => c.state === 'merged').length} of ${d.chunks.length} merged</span></div></div>` : '';
const sprintRings = d => `<div class="springs">${d.chunks.map(c => `<div class="spr" data-state="${esc(SPRINT_STATE[c.state] || 'unknown')}"><div class="ring" role="img" aria-label="${esc(c.id)} ${esc(c.state)} ${c.percent}%" style="--p:${c.percent}"><b>${c.percent}%</b></div><div class="spt"><b class="truncate">${esc(c.id)} · ${esc(c.title)}</b><span class="sm st">${esc(c.state)}${c.activity ? ` · <span data-activity="${esc(c.activity)}">${esc(c.activity)}</span>` : ''}${c.steps ? ` · <span data-steps>${esc(c.steps)}</span>` : ''}</span>${c.waitingOn && (c.state === 'waiting' || c.state === 'blocked') ? `<span class="sm wait">Waiting on: ${esc(c.waitingOn)}</span>` : ''}</div></div>`).join('') || '<p class="empty">No chunks in the status file yet.</p>'}</div>`;
// The modal's buttons: each is a registry script (asks first, like any script), found by its fixed id.
const SPRINT_SCRIPTS = [['sprint-start', 'Sprint start'], ['sprint-close', 'Sprint close'], ['sprint-heavy', 'Heavy services']];
const scriptById = id => Object.values(M.scripts).flat().find(s => s[0] === id && s[6]?.live);
// The tiles' pictures, site icons and program icons (the daemon fetches and caches; the renderer loads no remote image). Redraws only if they changed.
let lastArt = '';
async function loadArt() {
  const r = await window.p9.mission('icons').catch(() => null);
  if (r?.status !== 200 || lifetime.signal.aborted) return;
  const key = JSON.stringify(r.body); if (key === lastArt) return; lastArt = key;
  M.art = r.body; renderMission();
}
// Everything one overview carries, so the first load, an answer, a finished turn and the poll below show the same thing.
function applyOverview(o) {
  live.on = true; live.note = ''; live.noteRestart = false; live.restart = o.restart; live.settingsError = o.settingsError; live.primary = o.primary; live.waitDir = o.waiting; dataNote(); live.waiting = o.waiting.split('/').pop();
  M.scripts = {}; M.tools = [];
  for (const x of o.scripts) (M.scripts[x.group || 'Other'] ||= []).push([x.id, x.title, x.desc, 'idle', 'not run here yet', '', { args: x.args, confirm: x.confirm, terminal: x.terminal, live: true }]);
  M.apps = o.apps.map(a => [a.title, a.desc, a.terminal, a.id, a.icon]);
  M.pages = o.pages.map(x => [x.title, x.url, x.id, x.icon]);
  // The free-form space: each section is a tile, even one with no buttons yet; its buttons arrived in o.scripts.
  M.space = o.space || [];
  live.empty = Boolean(o.empty); live.fileProtection = o.fileProtection === true; live.spaces = o.spaces || []; live.spaceName = o.spaceName ?? null;
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
  loadArt(); // a site's icon can arrive or age out with no change to the overview
  const key = JSON.stringify(r.body); if (key === lastOverview) return; lastOverview = key;
  applyOverview(r.body); renderMission(); renderTabs();
  if (S.modal?.kind === 'scripts' && !M.scripts[S.modal.g]) closeModal(); // its group is gone
  else if (['scripts', 'win', 'reviews', 'center'].includes(S.modal?.kind)) renderModal();
}
const pollMission = () => { refreshMission(); setTimeout(pollMission, 20000); };
// _tyler/ items a chat makes get their card when its turn ends (Builder, 2026-10-17); otherwise the queue is read at start.
let queueTimer = 0;
const queueSoon = () => { clearTimeout(queueTimer); queueTimer = setTimeout(async () => { const r = await window.p9?.mission?.('overview').catch(() => null); if (live.on && r?.status === 200) { lastOverview = JSON.stringify(r.body); applyOverview(r.body); renderMission(); renderTabs(); if (S.modal?.kind === 'reviews' || S.modal?.kind === 'center') renderModal(); } }, 500); };
// D4 / #14: the chip on a waiting item says who it waits on: the owner's own name from Settings, else "needs you".
const needsLabel = () => settings.name ? 'needs ' + settings.name : 'needs you';
function applyQueue(o) {
  const drafts = Object.fromEntries(S.reviews.filter(x => x.live).map(x => [x.name, x]));
  const kept = S.reviews.filter(x => x.live && x.draft && x.draft.trim() && !o.queue.some(q => q.name === x.name));
  S.reviews = o.queue.map(q => { const file = live.waiting + '/' + q.name; if (S.docs[file]?.saved !== q.content) S.docs[file] = { text: q.content, saved: q.content, sel: [0, 0], top: 0 };
    return { proj: q.project, kind: needsLabel(), txt: q.title, file, age: q.age, updated: q.updated, name: q.name, hash: q.hash, live: true, draft: drafts[q.name]?.draft, sel: drafts[q.name]?.sel }; });
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
// A category's rows: its scripts, plus a space section's notes, log views, folder lists and references.
const sectionRows = (g, l) => { const sp = (M.space || []).find(x => x.title === g); return l.length + (sp ? (sp.notes ? 1 : 0) + sp.logs.length + (sp.folders?.length || 0) + (sp.refs?.length || 0) + (sp.data?.length || 0) + (sp.links?.length || 0) : 0); };
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
  else toast({ kind: 'not saved', txt: 'Could not save to ' + r.file + ': ' + saveWhy(res) + '. Your answer is still here.', level: 'bad' }, true);
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
const usageBody = () => (usage.limits ? usageRings() + `<ul class="plist" data-limits>${[limitLine('Claude', usage.limits.claude), limitLine('Codex', usage.limits.codex, undefined, usage.limits.signedOut?.includes('codex'))].map(l => `<li class="sm${l.stale ? ' muted' : ''}"><b>${l.name}</b> ${esc(l.text)}</li>`).join('')}</ul>` : '')
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
    body: () => `<div class="launch">${M.apps.map((a, i) => launchTile(a[0], a[1], `data-app="${i}"`, a[3], false, a[4], art('apps', a[3]))).join('')}${M.pages.map((p, i) => launchTile(p[0], p[1], `data-page="${i}"`, '', true, p[3], art('pages', p[2]))).join('')}</div>` },
  musage: { title: () => 'Usage', card: () => { const c = usage.limits && limitLine('Claude', usage.limits.claude); return [c ? c.text.split(' · ')[0].replace(/ \(.*/, '') : usage.totals.outputTokens.toLocaleString(), c ? 'Claude · ' + c.text : 'output tokens recorded', c?.stale ? 'warn' : 'ok']; }, body: usageBody,
    // On the page: each agent's 5 h and week as rings
    inline: () => { const rows = usageRings();
      return (rows ||'<p class="empty">No plan limits recorded yet.</p>') + (usage.state === 'unavailable' ? '' : `<p class="sm muted">${usage.totals.outputTokens.toLocaleString()} output tokens · $${usage.totals.costUsd.toFixed(2)} recorded</p>`); } },
};
// Icon order: P9's own icon for P9; else the user's picture, the emoji or text icon, the automatic icon (a site's, a program's), the letters.
// shown: {picture, auto} as data: URIs from the daemon, shown only through <img>.
const art = (kind, key) => M.art?.[kind]?.[key] || {};
const launchTile = (name, title, data, id, page, icon, shown = {}) => `<button class="ltile" data-launch="${esc(name)}" ${data} title="${esc(title)}">${id === 'p9' ? '<img src="/p9-icon.png" alt="">' : shown.picture || (!icon && shown.auto) ? `<img src="${esc(shown.picture || shown.auto)}" alt="">` : `<span class="mono-ico"${tint(name)}${icon ? ' data-icon' : ''}>${esc(icon || name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?')}</span>`}<span class="nm">${esc(name)}${page ? ' ↗' : ''}</span></button>`;
const winTop = {};
const winCard = id => { const w = wins[id], [big, line, lvl] = w.card();
  return `<button class="win${lvl === 'bad' ? ' bad fx-halo' : ''}" data-win="${id}"><h4><span class="lvl" data-l="${lvl}"></span>${esc(w.title())}</h4><b class="big${id === 'mprimary' ? ' fx-title' : ''}">${esc(big)}</b><span class="line">${esc(line)}</span></button>`; };
// Logs, Usage and Apps sit open on the page and scroll on their own, like Waiting on you (Builder, 2026-10-18 #3); the heading still
// opens the full window.
const PANELS = ['mlogs', 'musage', 'mlaunch'];
const winPanel = id => `<section class="mpanel" data-panel="${id}"><button class="phead" data-win="${id}"><h4>${esc(wins[id].title())}</h4><span>Open</span></button><div class="pscroll"></div></section>`;
// D9: an empty Mission (no buttons, apps, pages or waiting items yet) says what it is and how to set it up.
const missionEmpty = () => window.p9?.mission && !sampleView && !Object.keys(M.scripts).length && !M.apps.length && !M.pages.length && !S.reviews.length
  && (live.on || /not set up/.test(live.note));
const missionIntro = () => '<div class="sm" data-mission-intro role="note"><h4>What is Mission Control?</h4>'
  + '<p>Your control room: one place for the buttons that run your scripts, shortcuts to your apps and pages, and a list of what is waiting on you.</p>'
  + '<p class="muted">It reads three things from your workspace: a main project file, a file of buttons, apps and pages, and a folder with one .md file for each item waiting on you. Set up lets you point P9 at the ones you already have, or makes empty ones to start from.</p>'
  + '<div class="set-row">' + (window.p9?.chat ? '<button data-slot="button" data-variant="default" data-mission-setup>Set up Mission Control</button>' : '')
  + (window.p9?.openDocs ? '<button data-slot="button" data-variant="outline" data-mission-docs>How to add buttons</button>' : '') + '</div></div>';
// M4 (threat model row 72): the shipped guide and template list, fetched once the first time Mission is empty.
let guide = null;
async function loadGuide() {
  const r = await window.p9.mission('guide', {});
  if (r.status !== 200) return;
  guide = r.body;
  if (live.empty) renderMission();
  if (mdl.open && S.modal?.kind === 'guide') renderModal();
}
function bindSpacePick(root) {
  const pick = root.querySelector('[data-space-pick]');
  if (pick) pick.onchange = async () => {
    const r = await window.p9.mission('space', { name: pick.value || null });
    if (r.status !== 200) toast({ kind: 'not saved', txt: 'Space: ' + (r.body?.error || r.status), level: 'bad' }, true);
    refreshMission();
  };
}
function bindOnboard(root) {
  root.querySelectorAll('[data-build]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    const r = await window.p9.mission('build', { provider: b.dataset.build });
    b.disabled = false;
    if (r.status === 201) openModal({ kind: 'chat', id: r.body.conversation });
    else toast({ kind: 'chat', txt: b.textContent + ': ' + (r.body?.error || r.status), level: 'bad' }, true);
  });
  root.querySelectorAll('[data-yourself]').forEach(b => b.onclick = () => openModal({ kind: 'guide' }));
  root.querySelectorAll('[data-open-protect]').forEach(b => b.onclick = async () => { await $('#setBtn').onclick(); const input = $('#setProtect'); input?.scrollIntoView({ block: 'center' }); input?.focus(); });
  // File protection answers the first click 403 and arms the tile; the second click sends the user's confirmation, as the edit form does.
  root.querySelectorAll('[data-template]').forEach(b => b.onclick = async () => {
    const r = await window.p9.mission('template', { name: b.dataset.template, ...(b.dataset.armed ? { confirm: true } : {}) });
    if (r.status === 403 && !b.dataset.armed) { b.dataset.armed = '1'; b.querySelector('span').textContent = 'File protection is on. Click again to add this template.'; return; }
    toast({ kind: r.status === 201 ? 'saved' : 'not saved', txt: templateWords(r.status, r.body), level: r.status === 201 ? 'ok' : 'bad' }, true);
    if (r.status === 201) refreshMission();
  });
  bindSpacePick(root);
}
function renderMission() {
  // A fresh profile shows only the onboarding card (M4): no panels, nothing else to read yet.
  if (live.empty && !sampleView) {
    setHTML($('#fMission'), onboardCard({ templates: guide?.templates, spaces: live.spaces, current: live.spaceName, protect: live.fileProtection }, esc));
    bindOnboard($('#fMission'));
    if (!guide) loadGuide();
    return;
  }
  const groups = Object.entries(M.scripts);
  setHTML($('#fMission'), `<div class="tiles" aria-label="Script categories">${groups.map(([g, l]) => `<button class="tile${worst(l) === 'bad' ? ' bad fx-halo' : ''}" data-group="${esc(g)}"><span class="lvl" data-l="${worst(l)}"></span><b>${art('sections', g).picture ? `<img class="sec-ico" src="${esc(art('sections', g).picture)}" alt=""> ` : ''}${!art('sections', g).picture && (M.space || []).find(x => x.title === g)?.icon ? `<span data-icon>${esc(M.space.find(x => x.title === g).icon)}</span> ` : ''}${esc(g)}</b><span class="n">${sectionRows(g, l)}</span></button>`).join('')}${live.on ? '<button class="tile" data-idea><span></span><b>+ New idea</b></button>' + (SP.on ? '<button class="tile" data-sprint><span class="lvl" data-l="' + (SP.data ? 'ok' : 'bad') + '"></span><b>Sprint status</b><span class="n">' + (SP.data ? SP.data.chunks.filter(c => c.state === 'merged').length + '/' + SP.data.chunks.length : '!') + '</span></button>' : '') + '<button class="tile" data-medit><span></span><b>Edit names and icons</b></button>' : ''}${spacePicker(live.spaces || [], live.spaceName, esc)}</div>`
    + (live.note ? `<p class="muted sm" data-mission-note>${esc(live.note)}${live.noteRestart ? restartBtn() : ''}</p>` : '')
    + (missionEmpty() ? missionIntro() : '')
    + (live.on && H.hint ? `<p class="muted sm" data-hub-hint>${esc(H.hint)}</p>` : '')
    + (live.settingsError ? `<p class="sm" data-settings-error role="status">settings.json was changed but P9 cannot use it (${esc(live.settingsError)}). It keeps using the earlier settings until the file is fixed.</p>` : '')
    + (live.restart?.needed ? `<p class="sm" data-restart role="status"><b>Restart P9 to apply.</b> The workspace folder ${esc(live.restart.folder)} was not there when P9 started, so it is using the default folder.${restartBtn()}</p>` : '')
    // Waiting on you as a list on the page that scrolls on its own, with the big count workspace-hub had (Builder, 2026-10-18 #3). Three columns fill the window; each list scrolls inside itself.
    + '<div class="mrow"><section class="needs" aria-label="Waiting on you"><div class="nhead"><h4>Waiting on you</h4><select data-slot="select" aria-label="Sort" data-sort><option value="updated">Newest</option><option value="project">Project</option></select></div><div class="bignum"><b data-n></b><span data-unit></span></div><div data-list></div></section>'
    + '<div class="mcol"><div data-card="mprimary"></div>' + PANELS.slice(0, 1).map(winPanel).join('') + '</div>'
    + '<div class="mcol">' + PANELS.slice(1).map(winPanel).join('') + '<div class="wins" aria-label="Mission sections"></div></div></div>');
  $('#fMission').querySelectorAll('[data-group]').forEach(b => b.onclick = () => openModal({ kind: 'scripts', g: b.dataset.group }));
  $('#fMission').querySelectorAll('[data-restart-btn]').forEach(b => b.onclick = () => restartP9(b));
  bindSpacePick($('#fMission'));
  $('#fMission').querySelectorAll('[data-mission-setup]').forEach(b => b.onclick = () => welcome('mission'));
  $('#fMission').querySelectorAll('[data-mission-docs]').forEach(b => b.onclick = () => window.p9.openDocs('buttons-apps-and-pages').catch(() => {}));
  const sort = $('#fMission [data-sort]'); sort.value = reviewSort(); sort.onchange = () => { try { localStorage.setItem('eh-review-sort', sort.value); } catch {} reviewSort(); missionLive(); };
  // New idea on the page itself, where workspace-hub had it (Builder, 2026-10-18: it was hidden in the Workspace window).
  $('#fMission').querySelectorAll('[data-idea]').forEach(b => b.onclick = () => openModal({ kind: 'idea', name: '', text: '', needs: false }));
  $('#fMission').querySelectorAll('[data-medit]').forEach(b => b.onclick = () => openModal({ kind: 'medit', items: editItems(M) }));
  $('#fMission').querySelectorAll('[data-sprint]').forEach(b => b.onclick = () => openModal({ kind: 'sprint' }));
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
// A real file from the Chat Focus browser (threat model rows 23, 4, 7): the same editor as Dev Focus's fallback; Save is the one "save"
// action, the daemon's guarded PUT /files, so a changed file answers 409 and the draft stays (like a Mission note).
const liveKey = name => 'live:' + name;
function liveFileModal(m, body) {
  const key = liveKey(m.name);
  $('#mdlT').textContent = m.name;
  if (!m.asked && !dirty(key)) {
    m.asked = true;
    window.p9.mission('read', { path: m.name }).then(r => {
      if (r.status === 200 && !dirty(key)) S.docs[key] = { text: r.body.content, saved: r.body.content, hash: r.body.hash, sel: [0, 0], top: 0 };
      else if (r.status !== 200) m.error = r.body?.error || String(r.status);
      if (S.modal === m) renderModal();
    }).catch(() => { m.error = 'daemon-unavailable'; if (S.modal === m) renderModal(); });
  }
  const d = S.docs[key];
  if (!d) { body.innerHTML = `<p class="sm muted">${m.error ? 'Not readable: ' + esc(m.error) : 'Loading…'}</p>`; $('#mdlFoot').innerHTML = `<span class="muted sm mono truncate">${esc(m.name)}</span>`; return; }
  const c = m.conflict;
  body.innerHTML = (c ? `<div class="review notes-conflict" data-conflict>${c.diskHash !== undefined
    ? `<p>Changed on disk since you opened it. Your text is still here.</p><div class="notes-row"><button data-slot="button" data-variant="outline" data-size="sm" data-disk>Load disk version</button><button data-slot="button" data-size="sm" data-mine>Save mine over it</button></div>`
    : `<p>This file is no longer on disk (moved, renamed or deleted elsewhere). Your text is still here: copy it before you close.</p><div class="notes-row"><button data-slot="button" data-size="sm" data-copytext>Copy my text</button></div>`}</div>` : '')
    + editorHtml(key, 'mdlEd');
  wireEditor(body, key, () => liveFoot(m), () => saveLive(m));
  body.querySelector('[data-disk]')?.addEventListener('click', () => { Object.assign(d, { text: c.diskContent, saved: c.diskContent, hash: c.diskHash }); m.conflict = null; renderModal(); });
  body.querySelector('[data-mine]')?.addEventListener('click', () => saveLive(m, c.diskHash));
  body.querySelector('[data-copytext]')?.addEventListener('click', e => copy(d.text, e.currentTarget));
  liveFoot(m);
}
function liveFoot(m) {
  $('#mdlFoot').innerHTML = `<span class="muted sm mono truncate">${esc(m.name)}</span><span class="spacer"></span><span class="muted sm">Ctrl S</span>${saveBtn(liveKey(m.name))}`;
  const b = $('#mdlFoot [data-savefile]'); if (b) b.onclick = () => saveLive(m);
}
async function saveLive(m, hash) {
  const key = liveKey(m.name), d = S.docs[key]; if (!d || m.saving || (!hash && !dirty(key))) return;
  m.saving = true; const text = d.text;
  const r = await window.p9.mission('save', { path: m.name, hash: hash || d.hash, content: text }).catch(() => ({ status: 503 }));
  m.saving = false;
  if (r.status === 200) { d.saved = text; d.hash = r.body.hash; m.conflict = null; toast({ kind: 'saved', txt: 'Saved ' + m.name, level: 'ok' }, true); }
  else if (r.status === 409) { m.conflict = { diskContent: r.body.diskContent, diskHash: r.body.diskHash }; toast({ kind: 'not saved', txt: m.name + ' changed on disk since you opened it. Your text is still here.', level: 'warn' }, true); }
  else toast({ kind: 'not saved', txt: 'Could not save ' + m.name + ': ' + saveWhy(r) + '. Your text is still here.', level: 'bad', start: 'Your text is still in the editor, so nothing is lost. Fix the reason above (it names the file and why), then press Ctrl S again.' }, true);
  if (S.modal === m) renderModal();
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
  else toast({ kind: 'not saved', txt: 'Could not save ' + m.path + ': ' + saveWhy(r) + '. Your text is still here.', level: 'bad', start: 'Your text is still in the editor, so nothing is lost. Fix the reason above (it names the file and why), then press Ctrl S again.' }, true);
  if (S.modal === m) renderModal();
}
// Modal bodies for Mission: a category's buttons, one script (args, Run, output), a Wiki inbox batch
function missionModal(m, body, row) {
  if (m.kind === 'win') {
    const w = wins[m.id]; if (!w || (w.show && !w.show())) return closeModal();
    $('#mdlT').textContent = w.title();
    body.innerHTML = panel(m.id, esc(w.title()), w.body()); addHalos(body);
    bindWin(body, m); missionLive();
    body.onscroll = () => { winTop[m.id] = body.scrollTop; };
  } else if (m.kind === 'scripts') {
    if (!M.scripts[m.g]) return closeModal();
    const l = M.scripts[m.g], tools = m.g === 'Tools' ? M.tools : [], sp = (M.space || []).find(s => s.title === m.g);
    const n = sectionRows(m.g, l), word = n > l.length ? 'item' : 'script';
    $('#mdlT').textContent = `${m.g} · ${n} ${word}${n === 1 ? '' : 's'}`;
    body.innerHTML = (sp?.text ? `<p class="sm" data-space-text>${esc(sp.text)}</p>` : '') + `<ul class="mlist">${sp?.notes ? `<li><button data-notes="${esc(sp.notes)}"><span class="kind">notes</span><span class="truncate">Notes</span><span class="sub truncate">${esc(sp.notes)}</span></button></li>` : ''}${(sp?.folders || []).map((f, i) => `<li><button data-folder="${i}"><span class="kind">folder</span><span class="truncate">${esc(f.title)}</span><span class="sub" data-count>${m.counts?.[f.id] ?? '…'}</span></button></li>`).join('')}${(sp?.refs || []).map((r, i) => r.missing
      ? `<li><button data-ref-missing disabled title="No script, app or page has this ID"><span class="kind">ref</span><span class="truncate">${esc(r.id)}</span><span class="sub">not found</span></button></li>`
      : `<li><button data-ref="${i}"><span class="kind">${{ scripts: 'script', apps: 'app', pages: 'link' }[r.kind]}</span><span class="truncate">${esc(r.title)}</span></button></li>`).join('')}${(sp?.logs || []).map(g => `<li><button data-slog="${esc(g.id)}"><span class="kind">log</span><span class="truncate">${esc(g.title)}</span></button></li>`).join('')}${l.map((s, i) => row(i, `<span class="lvl" data-l="${esc(s[3])}"></span>`, esc(s[1]), esc(s[2]) + ' · ' + esc(s[4]) + ', ' + esc(s[5]))).join('')}${tools.map(t => `<li><button data-tool="${esc(t[0])}"><span class="kind">tool</span><span class="truncate">${esc(t[0])}</span><span class="sub truncate">${esc(t[1])}</span></button></li>`).join('')}</ul>`;
    // Data tiles and links (M3, threat model row 70): a tile asks the daemon only while this section is open on screen, every 30 s.
    m.tiles ||= {};
    if (sp?.data?.length || sp?.links?.length) body.insertAdjacentHTML('beforeend', `<div class="dtiles">${(sp.data || []).map(d => `<section class="dtile" data-tile="${esc(d.id)}"><h3>${esc(d.title)}</h3>${tileHtml(m.tiles[d.id], esc)}</section>`).join('')}${(sp.links || []).map(l => linkHtml(l, esc)).join('')}</div>`);
    const pull = (d) => window.p9.mission('data', { id: d.id }).then(r => { m.tiles[d.id] = tileAnswer(r.status, r.body); if (S.modal === m) renderModal(); });
    if (sp?.data?.length && !m.pulling) { sp.data.forEach(pull); m.pulling = setInterval(() => { if (S.modal !== m) return clearInterval(m.pulling); if (!document.hidden) sp.data.forEach(pull); }, 30000); }
    body.querySelectorAll('[data-tile-allow]').forEach(b => b.onclick = () => { const d = sp.data.find(x => x.id === b.closest('[data-tile]').dataset.tile);
      window.p9.mission('dataAllow', { id: d.id }).then(r => { if (r.status === 200) return pull(d); m.tiles[d.id] = tileAnswer(r.status, r.body); renderModal(); }); });
    body.querySelectorAll('[data-tile-link]').forEach(a => a.onclick = e => { e.preventDefault(); window.p9.openLink?.(a.href); });
    body.querySelectorAll('[data-i]').forEach(b => b.onclick = () => openModal({ kind: 'script', s: l[+b.dataset.i], back: m }));
    body.querySelectorAll('[data-slog]').forEach(b => b.onclick = () => openModal({ kind: 'hubtext', title: b.textContent.replace(/^log/, ''), req: { kind: 'space', name: b.dataset.slog }, back: m }));
    body.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => toast({ kind: 'launched', txt: b.dataset.tool + ' (mock: nothing opens)', level: 'ok' }, true));
    body.querySelectorAll('[data-notes]').forEach(b => b.onclick = () => openModal({ kind: 'notes', root: b.dataset.notes, title: m.g, back: m }));
    // Folder lists (row 68): the count comes from the daemon's own list, once per opening of the section.
    m.counts ||= {};
    for (const f of sp?.folders || []) if (!(f.id in m.counts)) {
      m.counts[f.id] = null;
      window.p9.mission('folder', { id: f.id }).then(r => { m.counts[f.id] = r.status === 200 ? r.body.total : '?'; if (S.modal === m) renderModal(); });
    }
    body.querySelectorAll('[data-folder]').forEach(b => b.onclick = () => openModal({ kind: 'folder', f: sp.folders[+b.dataset.folder], back: m }));
    // A reference (M2) opens what it names, the way its own tile does.
    body.querySelectorAll('[data-ref]').forEach(b => b.onclick = () => {
      const r = sp.refs[+b.dataset.ref];
      if (r.kind === 'scripts') { const s = Object.values(M.scripts).flat().find(x => x[0] === r.id); return s && openModal({ kind: 'script', s, back: m }); }
      if (!live.on) return toast({ kind: 'launched', txt: r.title + ' (mock: nothing opens)', level: 'ok' }, true);
      const page = r.kind === 'pages' ? M.pages.find(x => x[2] === r.id) : null;
      if (page && !/^https?:\/\//i.test(page[1])) return openModal({ kind: 'link', page, back: m });
      launchLive(r.title, { kind: r.kind, id: r.id });
    });
  } else if (m.kind === 'folder') {
    $('#mdlT').textContent = m.f.title;
    if (m.list === undefined) { m.list = null; window.p9.mission('folder', { id: m.f.id }).then(r => { m.list = r.status === 200 ? r.body : { error: r.body?.error || String(r.status) }; if (S.modal === m) renderModal(); }); }
    const l = m.list, now = Date.now();
    body.innerHTML = !l ? '<p class="sm muted">Loading…</p>' : l.error ? `<p class="sm muted">Could not list this folder (${esc(l.error)})</p>`
      : l.files.length ? `<ul class="mlist">${l.files.map((f, i) => row(i, '<span class="kind">file</span>', esc(f.name), esc(ago(Math.max(0, Math.round((now - f.modified) / 60000)))) + ' ago')).join('')}</ul>` : '<p class="empty">No files match.</p>';
    $('#mdlFoot').innerHTML = l && !l.error ? `<span class="muted sm" data-folder-count>${l.total} file${l.total === 1 ? '' : 's'}${l.files.length < l.total ? ', the newest ' + l.files.length + ' shown' : ''}${l.partial ? ' · a very big folder: not every file was looked at' : ''}</span>` : '';
    body.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const f = l.files[+b.dataset.i]; openModal({ kind: 'hubtext', title: f.name, req: { id: m.f.id, path: f.path }, call: 'folderFile', back: m }); });
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
    if (m.text === undefined) { m.text = 'Loading…'; window.p9.mission(m.call || 'hubText', m.req).then(r => { m.text = r.status === 200 ? r.body.text : 'Could not read it (' + (r.body?.error || r.status) + ')'; if (S.modal === m) renderModal(); }); }
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
  } else if (m.kind === 'sprint') {
    const d = SP.data;
    $('#mdlT').textContent = d ? 'Sprint · ' + (d.sprint || 'unnamed') : 'Sprint';
    body.innerHTML = `<div class="review" data-sprint-body>${d ? `${sprintOverall(d)}<p class="sm muted" data-sprint-times>${esc(sprintTimes(d))}${Number.isFinite(d.overall) ? '' : ` · ${d.chunks.filter(c => c.state === 'merged').length} of ${d.chunks.length} merged`}</p>${sprintRings(d)}`
      : `<p class="sm" role="status">The sprint status file is there but P9 cannot read it (${esc(SP.error)}).</p>`}${m.hint ? `<p class="sm" role="status">${esc(m.hint)}</p>` : ''}</div>`;
    $('#mdlFoot').innerHTML = SPRINT_SCRIPTS.map(([id, label]) => `<button data-slot="button" data-variant="outline" data-sprint-run="${id}"${scriptById(id) ? '' : ` disabled title="Add a ${id} button to the registry"`}>${label}</button>`).join('')
      + '<span class="spacer"></span><button data-slot="button" data-sprint-tmux>Open tmux</button>';
    $('#mdlFoot').querySelectorAll('[data-sprint-run]').forEach(b => b.onclick = () => openModal({ kind: 'script', s: scriptById(b.dataset.sprintRun), back: m }));
    $('#mdlFoot [data-sprint-tmux]').onclick = async () => {
      const r = await window.p9.mission('sprintTmux');
      if (r.status === 201) { closeModal(); showTerminal(r.body.terminal); }
      else { m.hint = 'Open tmux: ' + (r.body?.error || r.status); renderModal(); }
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
  } else if (m.kind === 'guide') {
    // "Build it yourself" (M4): the shipped guide, and the way to the edit form.
    $('#mdlT').textContent = 'Build it yourself';
    body.innerHTML = `<div class="msg agent notes-md" data-guide>${guide ? md.parse(guide.guide) : '<p class="muted">Loading the guide…</p>'}</div>`;
    if (!guide) loadGuide();
    $('#mdlFoot').innerHTML = '<span class="spacer"></span><button data-slot="button" data-guide-edit>Open the edit form</button>';
    $('#mdlFoot [data-guide-edit]').onclick = () => openModal({ kind: 'medit', items: editItems(M) });
  } else if (m.kind === 'medit') {
    $('#mdlT').textContent = 'Edit names and icons';
    editorModal(m, body, $('#mdlFoot'), { mission: window.p9.mission, pick: window.p9.pickPicture, art: () => M.art, esc, toast, again: () => S.modal === m && renderModal(),
      reload: async keep => { await refreshMission(); if (keep) S.modal === m && renderModal(); else openModal({ kind: 'medit', items: editItems(M) }); } });
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
// Dev Focus docks it only: the editor is a separate view drawn above this page, so a floating terminal went behind it.
function showTerm() {
  const f = S.focus, open = S.termOpen[f], float = f !== 'dev' && S.termMode[f] === 'float';
  if (dock.classList.contains('float') && !float) dock.style.height = dock.style.width = dock.style.left = dock.style.top = dock.style.translate = '';
  dock.hidden = !open; dock.classList.toggle('float', float);
  $('#dFloat').hidden = f === 'dev';
  $('#rTerm').setAttribute('aria-pressed', open);
  if (open && dockTerm && !dockTerm.open) openDock();
}
// A terminal the daemon just made (Hand off, the wizard's agent commands): the dock opens on it.
function showTerminal(id) {
  const shown = dockTerm?.open;
  S.termOpen[S.focus] = true; showTerm();
  if (shown) { dockTerm.attach(id); dockTerm.focus(); }
}
function toggleTerm() { S.termOpen[S.focus] = !S.termOpen[S.focus]; showTerm(); }
$('#dHide').onclick = toggleTerm;

/* ---------- focus modes ---------- */
// One look for every focus mode (v0.1.6): the picker in Chat or Mission Control also sets Dev Focus. The per-focus looks
// an older version saved are dropped; the look itself is saved on its own, so it still loads.
try { localStorage.removeItem('p9-focus-looks'); } catch {}
// All three focus panes stay in the DOM; switching only flips visibility, so nothing re-renders.
// A pick (rail, keys, CLI, landing) leaves the landing page and is kept as the last focus; `stay` is the app's own switching.
function setFocus(f, stay = false) {
  if (!settings.focus[f]) return; // turned off in Settings
  S.focus = f;
  if (f === 'mission') refreshMission();
  if (!stay) { try { localStorage.setItem('p9-last-focus', f); } catch {} leaveLanding(); }
  document.querySelectorAll('.fpane').forEach(p => { const on = p.dataset.focus === f; p.classList.toggle('on', on); p.inert = !on; });
  document.querySelector('.shell').dataset.focus = f;
  document.querySelectorAll('[data-focus-btn]').forEach(b => b.setAttribute('aria-pressed', b.dataset.focusBtn === f));
  renderIndicator(); // each focus has its own pets
  $('#focusTitle').textContent = focusNames[f];
  // In the desktop the Dev Focus editor is drawn above this page, so the theme picker would open behind it.
  const behind = f === 'dev' && Boolean(window.p9);
  $('#themeBtn').disabled = behind;
  $('#themeBtn').title = behind ? 'Look: pick it in Chat or Mission Control, where it applies to Dev Focus too (the editor here would cover the picker)' : 'Look: the theme of every focus mode';
  showTerm();
  side.focus();
  placeDev();
  cardsOverlay();
}
// In the desktop, Dev Focus is the real editor: a separate view (p9://dev) laid over this pane. In a browser the sample editor stays.
// The view draws above this page, so it steps aside: hidden while a dialog is open, and short of the cards' column while a card shows.
function placeDev() {
  if (!window.p9?.devView) return;
  const r = $('#fDev').getBoundingClientRect(), now = side.current();
  const visible = S.focus === 'dev' && r.width > 0 && r.height > 0 && !document.querySelector('dialog[open]') && now?.mode !== 'full';
  let x = r.x, y = r.y, right = r.right;
  // The side panel and its drag bar stay clear of the view (8 px), on whichever side the swap put it. The cards are not reserved for: they float over it (their own overlay view).
  if (now) { const s = $('#side').getBoundingClientRect(); if (s.left > r.x) right = Math.min(right, s.left - 8); else x = Math.max(x, s.right + 8); }
  const tab = $('#devTab').getBoundingClientRect(); if (tab.height) y = Math.max(y, tab.bottom);
  // The walkthrough card is on this page too: the editor starts right of it or below it, whichever leaves more editor.
  const k = $('#walk')?.getBoundingClientRect();
  if (k && k.right > x && k.left < right && k.bottom > y && k.top < r.bottom) {
    if ((right - k.right) * (r.bottom - y) >= (right - x) * (r.bottom - k.bottom)) x = k.right + 8; else y = k.bottom + 8;
  }
  // D14 (Builder, 2026-10-28: "It should never be hidden behind any panel"): the view draws above the page, so it keeps clear of a
  // floating terminal: the editor takes the biggest of the room left of it, right of it, above it or below it.
  let bottom = r.bottom;
  const d = $('#dock'), t = !d.hidden && d.classList.contains('float') ? d.getBoundingClientRect() : null; // $: placeDev runs before const dock
  if (t && t.right > x && t.left < right && t.bottom > y && t.top < bottom) {
    const room = ([a, b, c, d]) => Math.max(0, c - a) * Math.max(0, d - b);
    [x, y, right, bottom] = [[t.right + 8, y, right, bottom], [x, y, t.left - 8, bottom], [x, t.bottom + 8, right, bottom], [x, y, right, t.top - 8]].reduce((m, o) => room(o) > room(m) ? o : m);
  }
  window.p9.devView(visible ? { visible, x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(0, right - x)), height: Math.round(Math.max(0, bottom - y)) } : { visible });
}
new ResizeObserver(placeDev).observe($('#fDev'));
new ResizeObserver(cardsOverlay).observe($('.stage'));
new MutationObserver(() => { placeDev(); cardsOverlay(); }).observe(document.body, { subtree: true, attributeFilter: ['open'] });
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
  dockTerm = createTerminal({ screen: $('#termView'), connect: relaySocket, open: url => window.p9.openLink(url).catch(() => toast({ kind: 'link', txt: 'Link not opened', level: 'warn' }, true)), state: (text, on) => {
    $('#dState').textContent = text; $('#dBadge').textContent = on ? 'running' : 'closed'; $('#dBadge').dataset.variant = on ? 'ok' : 'warn'; $('#dRefresh').hidden = on; } });
  $('#term').hidden = true; $('#termView').hidden = false;
  dockTerm.show('No terminal open');
  $('#dRefresh').onclick = openDock;
  observe(() => dockTerm.fit()).observe($('#termView'));
  lifetime.signal.addEventListener('abort', () => dockTerm.close());
  showTerm();
});
const dock = $('#dock');
dragBar($('#grip'), { axis: 'y', dir: -1, get: () => dock.offsetHeight, set: px => { dock.style.height = px + 'px'; }, min: 120, max: () => innerHeight * .7, signal: lifetime.signal });
$('#dFloat').onclick = () => { S.termMode[S.focus] = S.termMode[S.focus] === 'float' ? 'drawer' : 'float'; dock.style.height = dock.style.width = dock.style.left = dock.style.top = dock.style.translate = ''; showTerm(); };
// Floating terminal (Builder, 2026-10-17: "wigs out on click and drag to move, highlights all the stuff below it, and wont resize").
// left/top are relative to the dock's parent, not the viewport (the jump); pointer capture and preventDefault stop the selection;
// CSS resize: both gives the corner handle.
dock.querySelector('.tb').onpointerdown = e => {
  if (!dock.classList.contains('float') || e.target.closest('button') || e.button !== 0) return;
  e.preventDefault(); const tb = e.currentTarget; tb.setPointerCapture(e.pointerId);
  const r = dock.getBoundingClientRect(), pr = dock.offsetParent.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
  dock.style.translate = 'none';
  const place = ev => { dock.style.left = Math.max(0, Math.min(pr.width - 80, ev.clientX - dx - pr.left)) + 'px'; dock.style.top = Math.max(0, Math.min(pr.height - 30, ev.clientY - dy - pr.top)) + 'px'; };
  place(e); tb.onpointermove = place; tb.onpointerup = tb.onpointercancel = () => { tb.onpointermove = tb.onpointerup = tb.onpointercancel = null; placeDev(); };
};
new ResizeObserver(() => placeDev()).observe(dock); // D14: opened, closed (display none), floated, docked or resized

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
    if (r.right < 80) Object.assign(el.style, { left: r.right + 14 + 'px', top: clamp(r.top - 8, innerHeight - h) + 'px' }); // the rail: beside it
    else Object.assign(el.style, { left: clamp(r.left, innerWidth - w) + 'px', top: (r.bottom + 14 + h < innerHeight ? r.bottom + 14 : clamp(r.top - 14 - h, innerHeight - h)) + 'px' });
  }
  el.querySelectorAll('[data-walk]').forEach(b => b.onclick = () => walkthrough(+b.dataset.walk, from));
  el.onkeydown = e => { if (e.key === 'Escape') walkthrough(WALKTHROUGH.length, from); };
  el.querySelector(`[data-walk="${i + 1}"]`).focus();
  placeDev();
  tickPets();
}
// MT1: what each Maintenance button (maintenance.mjs) and its Ctrl K entry does.
const maintain = {
  mtReload: () => location.reload(), // the window loads again; chats live in the daemon
  mtMission: async () => {
    await loadMission().catch(() => {});
    toast(live.on && !live.note ? { kind: 'mission', txt: 'Mission Control refreshed.', level: 'ok' } : { kind: 'mission', txt: live.note || 'Mission Control did not answer.', level: 'warn' }, true);
  },
  mtRestart: () => restartP9($('#mtRestart')),
  mtRepair: () => restartP9($('#mtRepair'), true),
  mtRebuild: async () => {
    const b = $('#mtRebuild'); if (b) { b.disabled = true; b.textContent = 'Rebuilding…'; }
    const r = await window.p9.rebuild().catch(() => ({ error: 'build-failed' })); // done: the window reloads
    if (b) { b.disabled = false; b.textContent = 'Rebuild + reload'; }
    if (r.error) toast({ kind: 'not rebuilt', txt: 'Could not rebuild P9 (' + r.error + (r.detail ? ': ' + r.detail : '') + ')', level: 'bad' }, true);
  },
};
const cmds = [['Notification Center', () => openModal({ kind: 'center' })], ['Walkthrough', () => walkthrough()],['Simulate an agent question', () => askNow()], ['Simulate a system notification', () => toast({ kind: 'silent job', txt: 'nightly-backup did not report in', level: 'bad' })], ['Chat Focus', () => setFocus('chat')], ['Dev Focus', () => setFocus('dev')], ['Mission Control', () => setFocus('mission')], ['New Codex session', () => newSession('codex', 'gpt-5.1-codex')], ['New Claude session', () => newSession('claude', 'Opus 5.5')], ['Toggle chat split', () => $('#rSplit').click()], ['Browse files', () => $('#rSearch').click()], ['Toggle files pane', () => $('#rFiles').click()], ['Toggle terminal', toggleTerm], ['Stop all sessions', () => $('#stopAll').click()], ['Look: Event Horizon', () => DUWOP.set('event-horizon')], ['Look: Redline', () => DUWOP.set('redline')], ['Look: Night Drive', () => DUWOP.set('night-drive')], ['Look: Duskwood', () => DUWOP.set('duskwood')], ...MAINTENANCE.filter(m => m.when()).map(m => [m.label, maintain[m.id]])];
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
let settings = { name: '', startLast: false, zoom: 1, closeOnSend: false, xfer: { fileMiB: 512, files: 20000, sendGiB: 4 },focus: { chat: true, dev: true, mission: true }, pet: { chat: { ...DEFAULT_PET }, dev: { ...DEFAULT_PET, on: false }, mission: { ...DEFAULT_PET, on: false } } }, agentLock = null, fileProtect = null, serverInfo = null, pets = null, petMode = null, updates = null, updatesTimer = 0;
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
  const mode = petMode ||= S.focus, f = settings.pet[mode], pick = (role, label, none) => `<label class="set-row"><span><strong>${label}</strong></span><span class="spacer"></span><select data-slot="input" id="setPet-${role}" data-pet-role="${role}"><option value="">${none}</option>${pets.pets.map(p => `<option value="${esc(p.name)}" ${f[role] === p.name ? 'selected' : ''}>${esc(p.displayName)}</option>`).join('')}</select>${info('The pet shown while ' + (role === 'system' ? 'P9 itself' : label) + ' is working.', 'pets')}</label>`;
  return `<fieldset class="set-group"><legend>Pets ${info('A small animated character (a petdex pet) that shows while an agent works, in place of the spinner (in Chat Focus chats and the top bar).', 'pets')}</legend>`
    + `<p class="muted sm">Find a pet at <a id="petdexLink" href="https://petdex.dev" target="_blank" rel="noopener">petdex.dev</a>, copy its install command and paste it below.</p>`
    + (window.p9?.installPets ? `<form class="set-row" id="petInstallForm"><input data-slot="input" id="petInstall" placeholder="npx petdex@latest install boba" autocomplete="off" spellcheck="false" style="flex:1"><button data-slot="button" data-variant="default" id="petInstallGo">Install</button></form>` : '')
    + `<div class="pet-lib">${pets.pets.map(p => `<figure><canvas data-thumb="${esc(p.name)}" width="192" height="208"></canvas><figcaption>${esc(p.displayName)}</figcaption><button data-slot="button" data-variant="ghost" data-size="icon-sm" data-pet-remove="${esc(p.name)}" title="Remove ${esc(p.displayName)}">×</button></figure>`).join('') || '<p class="muted sm">No pets yet.</p>'}</div>`
    + (window.p9?.addPets ? `<div class="set-row">${pets.importable ? `<button data-slot="button" data-variant="default" id="petImport">Import ${pets.importable} new petdex pet${pets.importable === 1 ? '' : 's'}</button>` : ''}<button data-slot="button" data-variant="outline" id="petAdd">Add pets…</button></div>` : '')
    + `<div class="set-row" role="group" aria-label="Focus mode">${Object.entries(focusNames).map(([m, n]) => `<button data-slot="button" data-variant="${m === mode ? 'default' : 'outline'}" data-size="sm" data-pet-mode="${m}" aria-pressed="${m === mode}">${n}</button>`).join('')}</div>`
    + `<label class="set-row"><input type="checkbox" id="setPetOn" ${f.on ? 'checked' : ''}><span><strong>Show pets in ${focusNames[mode]}</strong><span class="muted sm">Off: chats show no pet. The top-bar pet always shows.</span></span><span class="spacer"></span>${info('Shows the pets in this focus mode\'s chats.', 'pets')}</label>`
    + `<label class="set-row"><span><strong>Size</strong></span><span class="spacer"></span><input type="range" id="setPetSize" min="24" max="128" step="4" value="${f.size}"><span class="mono">${f.size}px</span>${info('How big the pets are in this focus mode.', 'pets')}</label>`
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
// ST1/ST2: Settings → Mission Control files, the daemon's settings.json (not this window's settings), so the paths stay
// editable after setup. The wizard's path rows (PATH_KEYS) plus the other keys; each row saves on change through the daemon,
// which checks it as it checks the file at start. A refused value stays in its box with the reason under it.
let missionFiles = null;
function missionGroup() {
  const s = missionFiles.settings;
  return `<fieldset class="set-group" id="setMission"><legend>Mission Control files ${info('The files and folders Mission Control reads, from its settings file (for the Mission Control focus). Each row saves when you leave it.', 'mission-control-files')}</legend>`
    + missionKeys().map(([k, name, kind, tip]) => `<label class="set-row"><span><strong>${esc(name)}</strong></span><span class="spacer"></span>`
      + (k === 'notes_roots' ? `<textarea data-slot="input" class="mono" data-mission="${k}" rows="2" maxlength="8000" spellcheck="false">${esc(missionShown(k, s[k]))}</textarea>`
        : `<input data-slot="input" class="mono" data-mission="${k}" value="${esc(missionShown(k, s[k]))}" title="${esc(missionShown(k, s[k]))}" maxlength="400" autocomplete="off" spellcheck="false">`)
      + (window.p9.pickFolder && kind ? `<button data-slot="button" data-variant="outline" data-size="sm" data-mission-pick="${k}:${kind}">Pick</button>` : '')
      + info(tip, 'mission-control-files') + '</label>').join('')
    + '<p class="muted sm">The old file is kept as settings.json.bak.</p></fieldset>';
}
async function saveMission(change) {
  const r = await window.p9.chat('saveMissionFiles', change).catch(() => ({ status: 503, body: { error: 'daemon-unavailable' } }));
  const box = $('#setBody').querySelector(`[data-mission="${Object.keys(change)[0]}"]`), row = box?.closest('.set-row');
  row?.querySelector('[data-mission-err]')?.remove(); box?.removeAttribute('aria-invalid');
  if (r.status === 200) { missionFiles = { ...missionFiles, settings: r.body.settings }; loadMission(); return; }
  const why = 'Not saved: ' + (r.body?.detail || WIZ_ERR[r.body?.error]?.[0] || r.body?.error || r.status);
  if (!row) return toast({ kind: 'mission-files', txt: why, level: 'bad' }, true);
  box.setAttribute('aria-invalid', 'true');
  row.insertAdjacentHTML('beforeend', `<small class="field-err" data-mission-err role="alert">${esc(why)}</small>`);
}
// A narrow box shows the end of a long path (the file name), not the start every path shares; the full path is the hover.
const showEnd = box => { box.title = box.value; box.scrollLeft = box.scrollWidth; };
function wireMission() {
  $('#setBody').querySelectorAll('input[data-mission]').forEach(box => { showEnd(box); box.onblur = () => showEnd(box); });
  $('#setBody').querySelectorAll('[data-mission]').forEach(box => { box.onchange = () => saveMission({ [box.dataset.mission]: missionValue(box.dataset.mission, box.value) }); });
  $('#setBody').querySelectorAll('[data-mission-pick]').forEach(b => { b.onclick = async e => {
    e.preventDefault();
    const [k, kind] = b.dataset.missionPick.split(':');
    const picked = await window.p9.pickFolder(kind).catch(() => undefined);
    if (picked === undefined) return;
    if (picked === null || picked === '') return toast({ kind: 'mission-files', txt: WIZ_ERR[picked === '' ? 'pick-root' : 'pick-outside'].join(' '), level: 'warn' }, true); // BL6
    $('#setBody').querySelector(`[data-mission="${k}"]`).value = picked;
    saveMission({ [k]: picked });
  }; });
}
// Settings > Remote (desktop/remote.mjs, D3): the remotes added here, then the Host lines of ~/.ssh/config (as VS Code Remote-SSH
// lists them). Nothing is built in; Add remote takes a Host name or user@address.
function serverRow() {
  const { host, connected, error, hosts, remotes = [] } = serverInfo, all = [...new Set([...remotes, ...hosts])];
  const note = host ? (connected ? 'This window works on ' + host + '. Chats there keep running when you switch or quit.' : 'Connecting to ' + host + (error ? ' (' + error + ')' : '') + '.')
    : all.length ? 'This window works on this computer. Connect to a remote to work on its P9 over ssh.' : 'No remotes yet. Add one below.';
  const rows = all.map(h => '<li class="set-row"><span><strong>' + esc(h) + '</strong><span class="muted sm">' + (remotes.includes(h) ? 'Added here' : 'From ~/.ssh/config') + '</span></span><span class="spacer"></span>'
    + (h === host ? '<span class="muted sm">' + (connected ? 'Connected' : 'Connecting…') + '</span>' : '<button data-slot="button" data-variant="outline" data-size="sm" data-remote-go="' + esc(h) + '">Connect</button>')
    + (remotes.includes(h) && h !== host ? '<button data-slot="button" data-variant="ghost" data-size="sm" data-remote-remove="' + esc(h) + '" aria-label="Remove ' + esc(h) + '">Remove</button>' : '') + '</li>').join('');
  return '<fieldset class="set-group" id="setRemote"><legend>Remote ' + info('Remote mode: chat, Mission Control, the terminal and Dev Focus use the P9 on another machine, through an ssh tunnel (the way VS Code Remote-SSH works). This computer\'s P9 keeps running, and Use this computer goes back. ssh to the remote must work without a password prompt. Folder pickers, Open in VS Code and Repair stay on this computer.', 'server-mode-send-to-server-and-send-files') + '</legend>'
    + '<p class="muted sm">' + esc(note) + '</p>' + (rows ? '<ul class="remote-list">' + rows + '</ul>' : '')
    + '<form class="set-row" id="setRemoteAdd"><input data-slot="input" id="setRemoteName" placeholder="Host name or user@address" aria-label="Remote to add" maxlength="253" autocomplete="off" spellcheck="false"><button data-slot="button" data-variant="default">Add remote</button></form>'
    + '<p class="warn sm" id="setRemoteErr" role="alert" hidden></p>'
    + (host ? '<div class="set-row"><span class="spacer"></span><button data-slot="button" data-variant="outline" id="setServerLocal">Use this computer</button></div>' : '') + '</fieldset>';
}
// c18 (threat model row 66): Settings > Security settings, the words and the device's part in security.mjs, shared with the phone.
const START = 'p9-mode-default:'; // Unrestricted mode sets the D2 default (row 25a), so new chats here start loosened
function securityGroup(box) {
  const [lock, protect, warn, free] = [SECURITY.lock, SECURITY.protect, SECURITY.warn, SECURITY.unrestricted], both = window.p9?.chat && window.p9?.fileProtection;
  return `<fieldset class="set-group" id="setSecurity"><legend>Security settings ${info('One switch per restriction, and Unrestricted mode for all of them at once. The defaults keep P9 careful; turn off what gets in your way. The phone has the same four.', 'security-settings')}</legend>`
    + (window.p9?.chat ? box('setLock', lock[0], agentLock === true, agentLock === null ? SECURITY.unknown : lock[1], agentLock === null, lock[2], 'agent-lock') : '')
    + (window.p9?.fileProtection ? box('setProtect', protect[0], fileProtect !== false, fileProtect === null ? SECURITY.unknown : fileProtect ? protect[1] : SECURITY.protectOff, fileProtect === null, protect[2], 'file-protection') : '')
    + box('setWarn', warn[0], warnsLoose(), warn[1], false, warn[2], 'security-settings')
    + (both ? box('setFree', free[0], unrestricted(agentLock, fileProtect, START), free[1], agentLock === null || fileProtect === null, free[2], 'security-settings') : '')
    + '</fieldset>';
}
// On: File protection first, through main's native warning; "Keep protection on" there changes nothing else. With
// protection already off that warning never shows, so Unrestricted asks once itself (row 25a: no silent loosened default).
async function setUnrestricted(on) {
  if (on && fileProtect === false && !confirm('Turn on Unrestricted mode?\n\n' + SECURITY.unrestricted[1])) return renderSettings();
  const r = fileProtect === !on ? null : await window.p9.fileProtection(!on).catch(() => null);
  fileProtect = r?.status === 200 ? r.body.on : fileProtect;
  if (fileProtect !== !on) return renderSettings();
  if (on && agentLock) { const l = await liveChat.call('setLock', { on: false }); agentLock = l.status === 200 ? l.body.on : agentLock; }
  setWarnsLoose(!on); setStarts(on, START);
  renderSettings();
}
// D6: the loose rows at the top become a General group; past four groups a page selector shows one (or all) at a time.
let setPage = 'All';
function settingsPages() {
  const body = $('#setBody'), loose = [...body.children].filter(c => c.tagName !== 'FIELDSET');
  if (loose.length) { const g = document.createElement('fieldset'); g.className = 'set-group'; g.innerHTML = '<legend>General ' + info('The docs, zoom, your name, and how P9 opens and closes its windows.', 'settings') + '</legend>'; g.append(...loose); body.prepend(g); }
  const groups = [...body.children], name = g => g.querySelector('legend')?.firstChild?.textContent.trim() || '';
  if (groups.length < 5) return $('#setDlg .set-pages')?.remove();
  if (setPage !== 'All' && !groups.some(g => name(g) === setPage)) setPage = 'All';
  $('#setDlg .set-pages')?.remove();
  const nav = document.createElement('nav'); nav.className = 'set-pages'; nav.setAttribute('aria-label', 'Settings pages');
  for (const n of ['All', ...groups.map(name)]) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = n; b.dataset.setPage = n; b.setAttribute('aria-pressed', n === setPage);
    b.onclick = () => { setPage = n; renderSettings(); }; nav.append(b);
  }
  groups.forEach(g => { g.hidden = setPage !== 'All' && name(g) !== setPage; });
  body.classList.toggle('one', setPage !== 'All'); $('#setDlg .dlg-head').after(nav);
}
function renderSettings() {
  const on = Object.values(settings.focus).filter(Boolean).length;
  const box = (id, label, checked, note = '', disabled = false, tip = '', section = 'settings') => `<label class="set-row"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span><strong>${label}</strong>${note ? `<span class="muted sm">${note}</span>` : ''}</span>${tip ? '<span class="spacer"></span>' + info(tip, section) : ''}</label>`;
  $('#setBody').innerHTML = `<div class="set-row"><a data-slot="button" data-variant="outline" id="setDocs" href="https://github.com/JudgeBreddd/p9#readme" target="_blank" rel="noopener">P9 docs on GitHub</a><button data-slot="button" data-variant="outline" id="setAm">Anymouse</button>${window.p9?.chat ? '<button data-slot="button" data-variant="outline" id="setWel">Setup</button>' : ''}<span class="spacer"></span>${info('The P9 guide (opens on GitHub), Anymouse (a note to P9\'s makers: an idea, a bug or a gripe) and Setup (the first-start window again).', 'settings')}</div>`
    + (window.p9?.setSettings ? `<div class="set-row"><span><strong>Zoom</strong><span class="muted sm">Ctrl = and Ctrl - from the shell; Ctrl 0 resets</span></span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="icon-sm" id="zOut" title="Zoom out">−</button><span class="mono" id="zVal">${Math.round(settings.zoom * 100)}%</span><button data-slot="button" data-variant="outline" data-size="icon-sm" id="zIn" title="Zoom in">+</button><button data-slot="button" data-variant="ghost" data-size="sm" id="zReset">Reset</button>${info('Makes everything in this window bigger or smaller, in every focus mode.', 'settings')}</div>` : '')
    + `<label class="set-row"><span><strong>Your name</strong><span class="muted sm">The landing page greets you with it. Empty: no name.</span></span><span class="spacer"></span><input data-slot="input" id="setName" maxlength="40" autocomplete="off" spellcheck="false">${info('The name the landing page greets you with.', 'settings')}</label>`
    + box('setStartLast', 'Start in my last focus mode', settings.startLast, 'Skips the landing page when P9 opens. The Event Horizon mark, top left, still opens it.', false, 'P9 opens straight into the focus mode you used last (Chat Focus, Dev Focus or Mission Control), not the landing page.')
    + box('setCloseSend', 'Close the chat window on send', settings.closeOnSend, 'A chat opened from a card or the Notification Center closes once your message is sent.', false, 'A chat window opened from a Chat Focus card or the Notification Center closes once you send your message.')
    + `<fieldset class="set-group"><legend>New chats start in ${info('The mode a new chat starts in, per agent. Last mode picked: the mode you picked last in a chat. Full access and Bypass permissions ask first, in red, unless you ticked Don\'t show again for them; a loosened last pick does not start a new chat on its own. The agent lock still wins.', 'settings')}</legend>${Object.keys(modes).map(a => `<label class="set-row"><span><strong>${names[a]}</strong></span><span class="spacer"></span><select data-slot="input" data-default-mode="${a}"><option value="">Last mode picked</option>${modes[a].map(m => `<option${m === defaultMode(a) ? ' selected' : ''}>${m}</option>`).join('')}</select></label>`).join('')}</fieldset>`
    + `<fieldset class="set-group"><legend>Focus modes ${info('The three workspaces of P9: Chat Focus, Dev Focus and Mission Control. Turn off the ones you do not use; at least one stays on.', 'focus-modes')}</legend>${Object.entries(focusNames).map(([f, n]) => box('setF-' + f, n, settings.focus[f], '', settings.focus[f] && on === 1)).join('')}</fieldset>`
    + (pets ? petSettings() : '')
    + securityGroup(box)
    + (missionFiles?.settings ? missionGroup() : '')
    + (serverInfo ? serverRow() : '')
    + (window.p9?.xferPlan && settings.xfer ? `<fieldset class="set-group"><legend>Send files ${info('Limits on one Send files to remote (the files panel\'s button): a send past one is refused before anything is copied, and the refusal names the limit.', 'send-files')}</legend>${Object.entries(XFER_SETTINGS).map(([k, [label, unit, max]]) => `<label class="set-row"><span><strong>${label}</strong><span class="muted sm">${unit}, 1 to ${max.toLocaleString()}</span></span><span class="spacer"></span><input data-slot="input" type="number" min="1" max="${max}" step="1" id="setXfer-${k}" data-xfer-limit="${k}" value="${settings.xfer[k]}" style="width:9em"></label>`).join('')}</fieldset>` : '')
    + maintenanceGroup(updates);
  settingsPages();
  const zoom = z => saveSettings({ ...settings, zoom: Math.round(Math.min(3, Math.max(0.5, z)) * 10) / 10 });
  if ($('#zIn')) { $('#zIn').onclick = () => zoom(settings.zoom + 0.1); $('#zOut').onclick = () => zoom(settings.zoom - 0.1); $('#zReset').onclick = () => zoom(1); }
  $('#setName').value = settings.name || '';
  $('#setName').onchange = e => saveSettings({ ...settings, name: e.target.value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 40) });
  $('#setStartLast').onchange = e => saveSettings({ ...settings, startLast: e.target.checked });
  $('#setBody').querySelectorAll('[data-xfer-limit]').forEach(el => { el.onchange = () => { const k = el.dataset.xferLimit, n = Math.round(Number(el.value));
    if (!Number.isFinite(n)) { el.value = settings.xfer[k]; return; }
    saveSettings({ ...settings, xfer: { ...settings.xfer, [k]: Math.min(XFER_SETTINGS[k][2], Math.max(1, n)) } }); }; });
  $('#setCloseSend').onchange = e => saveSettings({ ...settings, closeOnSend: e.target.checked });
  $('#setBody').querySelectorAll('[data-default-mode]').forEach(el => { el.onchange = async () => {
    const a = el.dataset.defaultMode, m = el.value;
    if (LOOSE[m] && !localStorage.getItem('p9-mode-ok:' + m) && !await looseOk(a, m)) { el.value = defaultMode(a); return; }
    m ? localStorage.setItem('p9-mode-default:' + a, m) : localStorage.removeItem('p9-mode-default:' + a);
  }; });
  if (pets) wirePetSettings();
  if (missionFiles?.settings) wireMission();
  // Main reloads the window onto the chosen daemon, so nothing here re-renders.
  $('#setBody').querySelectorAll('[data-remote-go]').forEach(b => { b.onclick = () => window.p9.server(b.dataset.remoteGo); });
  const remotesNow = async (action, name) => { const r = await window.p9.remotes(action, name).catch(() => null); if (r) serverInfo.remotes = r.remotes; renderSettings(); serverMenu(); };
  $('#setBody').querySelectorAll('[data-remote-remove]').forEach(b => { b.onclick = () => remotesNow('remove', b.dataset.remoteRemove); });
  if ($('#setRemoteAdd')) $('#setRemoteAdd').onsubmit = e => {
    e.preventDefault();
    const name = $('#setRemoteName').value.trim(), err = $('#setRemoteErr');
    // The same rule as main's (desktop/remote.mjs HOST); main checks again.
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/.test(name)) { err.hidden = false; err.textContent = 'A remote is a Host name from ~/.ssh/config or user@address: letters, digits and . _ - @, starting with a letter or digit.'; return; }
    remotesNow('add', name);
  };
  if ($('#setServerLocal')) $('#setServerLocal').onclick = () => window.p9.server(null);
  Object.keys(focusNames).forEach(f => { $('#setF-' + f).onchange = e => saveSettings({ ...settings, focus: { ...settings.focus, [f]: e.target.checked } }); });
  if ($('#setLock')) $('#setLock').onchange = async e => { const r = await liveChat.call('setLock', { on: e.target.checked }); agentLock = r.status === 200 ? r.body.on : agentLock; renderSettings(); };
  // Main shows the warning when this turns it off; the box then shows what the daemon says, so a "Keep" answer re-checks it.
  if ($('#setProtect')) $('#setProtect').onchange = async e => { const r = await window.p9.fileProtection(e.target.checked).catch(() => null); fileProtect = r?.status === 200 ? r.body.on : fileProtect; renderSettings(); };
  $('#setWarn').onchange = e => { setWarnsLoose(e.target.checked); renderSettings(); };
  if ($('#setFree')) $('#setFree').onchange = e => setUnrestricted(e.target.checked);
  $('#setDocs').onclick = e => { if (window.p9?.openDocs) { e.preventDefault(); window.p9.openDocs(); } }; // a browser preview follows the link
  $('#setAm').onclick = () => { $('#setDlg').close(); $('#amBtn').click(); };
  if ($('#setWel')) $('#setWel').onclick = () => { $('#setDlg').close(); welcome(); };
  MAINTENANCE.forEach(m => { if ($('#' + m.id)) $('#' + m.id).onclick = maintain[m.id]; });
  const asked = async ask => { updates = await window.p9.updates(ask).catch(() => updates); renderSettings(); };
  if ($('#mtUpdCheck')) $('#mtUpdCheck').onclick = () => asked({ check: true });
  if ($('#mtUpdInstall')) $('#mtUpdInstall').onclick = () => asked({ install: true });
  if ($('#mtUpdOpen')) $('#mtUpdOpen').onclick = () => window.p9.openUpdates();
  clearTimeout(updatesTimer); // a check or download in progress: show its next state while Settings is open
  if (['checking', 'downloading'].includes(updates?.state)) updatesTimer = setTimeout(() => { if ($('#setDlg').open) asked(); }, 2000);
  // HI1: an "i" shows its tip on hover and opens its part of the guide on click (main allows only the guide's sections).
  $('#setBody').querySelectorAll('[data-docs]').forEach(b => { b.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    window.p9?.openDocs?.(b.dataset.docs).catch(() => {}); // a browser preview: the tip only
  }; });
}
$('#setBtn').onclick = async () => {
  if (window.p9?.listPets) pets = await window.p9.listPets().catch(() => null);
  if (window.p9?.chat) { const r = await liveChat.call('lock'); agentLock = r.status === 200 ? r.body.on : null; }
  if (window.p9?.fileProtection) { const r = await window.p9.fileProtection().catch(() => null); fileProtect = r?.status === 200 ? r.body.on : null; }
  serverInfo = window.p9?.server ? await window.p9.server().catch(() => null) : null;
  if (window.p9?.chat) { const r = await window.p9.chat('missionFiles', {}).catch(() => null); missionFiles = r?.status === 200 ? r.body : null; }
  updates = window.p9?.updates ? await window.p9.updates().catch(() => null) : null;
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
  // D15a: a remote that is not answering (no P9 there yet) has no setup to read: none is asked, and no toast.
  const st = await window.p9.getStatus?.().catch(() => null);
  if (st?.mode === 'server' && st.status !== 'ok') return null;
  const r = await liveChat.call('setup', paths || {}).catch(() => null);
  return r?.status === 200 ? r.body : null;
}
// The four checks the card counts. Off Linux tmux is null and counts as done: the dock's terminals are tmux there only.
// pick (item 15): an agent installed or signed in; while it is false the wizard asks Claude, Codex or both first. The
// card leaves it out: a missing pick is a missing sign-in too.
function setupDone(s) { return { workspace: s.writable, pick: s.claudeCli || s.codexCli || s.claude || s.codex, agents: s.claude || s.codex, mission: s.settings && s.agentsFile && s.registryFile, terminal: s.tmux !== false }; }
function welSkipped() { try { return localStorage.getItem('p9-welcome-skipped') === '1'; } catch { return false; } }
// Item 15: the agents the wizard offers, each with the one line that says what it needs.
const AGENTS_PICK = [['claude', 'Claude', 'Claude Code, by Anthropic. Needs a Claude account (Pro, Max or Team) or an API key.'], ['codex', 'Codex', 'Codex, by OpenAI. Needs a ChatGPT account (Plus, Pro or Business) or an API key.']];
// What the pick step shows as picked: this run's choice, else what is installed or signed in already.
const wizPicked = () => W.picked || AGENTS_PICK.filter(([a]) => W.s?.[a + 'Cli'] || W.s?.[a]).map(([a]) => a);
const wizReady = () => { const on = wizPicked(); return on.length > 0 && on.every(a => W.s?.[a + 'Cli']); };
// The admin screen's name for each system item /setup can report missing (deps.mjs wizardDependencies).
const ADMIN_NAMES = { tmux: 'tmux', ssh: 'SSH client' };
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
const W = { i: 0, s: null, login: {}, timer: 0, note: {}, code: '', name: null, busy: '', then: null, paths: null, picked: null };
// The paths the wizard would write: the owner's edits, else what the daemon proposed (what it found, filled in with the
// starter paths). Empty fields are left out; hub is optional.
const wizPaths = () => Object.fromEntries(Object.entries(W.paths || W.s?.proposed || {}).filter(([k, v]) => PATH_KEYS.some(([key]) => key === k) && v));
const wizChoosing = s => s && ((!s.settings && !s.settingsPresent) || s.conflict);
const wizSteps = () => ['welcome', 'workspace', 'pick', 'agents', 'mission', ...(W.s?.tmux === null ? [] : ['terminal']), 'you', 'done'];
// D17: stale = the chat said this agent is not signed in. Its login file can outlive the login, so /setup still says
// signed in; the step believes the chat until a sign-in started here ends well.
async function welcome(at, agent, stale) {
  if (!window.p9?.chat) return; // a browser preview has no daemon to set up
  Object.assign(W, { note: {}, code: '', name: null, busy: '', paths: null, remote: false, hosts: null, picked: null, stale: stale ? agent : null, began: null });
  W.s = await loadSetup();
  if (agent) W.picked = [...new Set([...wizPicked(), agent])];
  const d = W.s && setupDone(W.s);
  W.i = typeof at === 'string' ? Math.max(0, wizSteps().indexOf(at)) : at ?? Math.max(0, d ? wizSteps().findIndex(k => d[k] === false) : 0);
  // BL5: every 10 s (was 2 s) while a check fails or a sign-in runs; wizRefresh stops it once neither is so, and starts it again.
  clearInterval(W.timer); W.timer = setInterval(wizRefresh, 10000);
  await wizRefresh();
  if (!$('#welDlg').open) $('#welDlg').showModal();
}
async function wizRefresh() {
  const [s, l] = await Promise.all([loadSetup(W.paths && wizPaths()), window.p9.agentLogin('state').catch(() => null)]);
  W.s = s; W.login = l?.status === 200 ? l.body : {};
  const began = W.login[W.began];
  if (began && !began.running) { if (began.exit === 0 && W.stale === W.began) W.stale = null; W.began = null; }
  if (s) { S.setup = Object.values(setupDone(s)).includes(false) ? s : null; renderCards(); }
  if (s && !S.setup && !Object.values(W.login).some(l => l?.running)) { clearInterval(W.timer); W.timer = 0; }
  else if (!W.timer && $('#welDlg').open) W.timer = setInterval(wizRefresh, 10000); // a sign-in started after setup was done
  wizRender();
}
// Each error a step can get back, as [cause, fix].
const WIZ_ERR = {
  'daemon-unavailable': ["P9's background service is not answering.", 'It restarts on its own. Retry in a few seconds.'],
  'daemon-outdated': ["P9's background service is older than this app, so it does not have this step.", 'Update P9 where its background service runs (or restart that service after an update), then try again.'],
  'workspace-change-unsupported': ["On this system the folder can't be changed from here.", 'P9 changes it on Linux and Windows.'],
  'workspace-refused': ["That folder can't be the workspace.", "Pick a folder of your own: not your home folder itself, a drive's root or P9's own state folder."],
  'service-missing': ["P9's background service is not installed.", "Run P9's installer again (the README's Install section), then Retry."],
  'stop-all-failed': ['Something running would not stop, so the folder stayed the same.', 'Stop it in Chat or the terminal dock, then Change the folder again.'],
  'workspace-not-started': ['P9 could not start in that folder, so it went back to the one it was on.', 'Pick another folder.'],
  'workspace-unwritable': ['P9 cannot write to this folder.', 'Change the folder, or give your user write access to this one, then Retry.'],
  'terminal-start-failed': ['The terminal did not open.', 'Retry, or open a terminal of your own and run the command shown.'],
  'terminal-unavailable': ['The terminal did not open.', 'Retry, or open a terminal of your own and run the command shown.'],
  'stop-all-running': ['Stop all is still running.', 'Retry when it is done.'],
  updating: ['P9 is updating and restarts in a moment.', 'Send again in a minute.'],
  'tmux-not-found': ['tmux is not installed.', 'Install it with your package manager (sudo apt install tmux, sudo dnf install tmux or sudo pacman -S tmux), then Retry. The rest of P9 works without it.'],
  'agents-not-installed': ['P9 could not put the agent where its terminals find it.', 'Continue without it goes on: chats still work, they use the agent P9 ships.'],
  'nothing-to-install': ['That is installed now.', 'Retry checks again.'],
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
  'pick-root': ['That is the workspace folder itself.', 'Pick a file or folder inside it.'],
  'server-mode-local-only': ["That changes this computer's P9, and this window is working on a remote.", 'Switch to Local (the top-bar badge or Settings > Remote), then try again.'],
  'path-is-a-file': ['That path names a file where P9 needs a folder.', 'Pick a folder for it, or move that file out of the way, then Create again.'],
};
// The hosts are the Host lines of ~/.ssh/config (W.hosts, read when the choice opens); connecting reloads this window onto that P9.
function wizRemote(btn) {
  const h = W.hosts, hosts = [...new Set([...(h?.remotes || []), ...(h?.hosts || [])])], opts = hosts.map(x => '<option value="' + esc(x) + '"' + (x === (h.last || hosts[0]) ? ' selected' : '') + '>' + esc(x) + '</option>').join('');
  return '<div data-wiz-remote>' + (hosts.length
    ? `<div class="set-row"><span><strong>Which machine</strong><span class="muted sm">A remote added in Settings > Remote, or a Host from ~/.ssh/config. ssh to it must work without a password prompt, and P9 must already run there.</span></span><span class="spacer"></span><select data-slot="input" id="welHost">${opts}</select>${btn('connect', 'Connect', 'default')}</div>`
    : `<p class="muted sm">No remotes yet. Add one with Add remote in Settings > Remote (a Host name from ~/.ssh/config or user@address), check that ssh to it works without a password prompt, then Retry.</p><div class="set-row">${btn('remote-retry', 'Retry')}</div>`)
    + (W.note.remote?.error ? `<p class="warn sm" role="alert">Could not connect (${esc(W.note.remote.error)}). Settings > Remote shows why and switches back to this computer.</p>` : '') + '</div>';
}
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
    title = 'Welcome to Event Horizon'; next = btn('next', window.p9?.server ? 'Set up this computer' : 'Start', 'default');
    // D1: P9 can also be this window onto a P9 that runs on another machine (Server mode, Settings > Server).
    body = `<p>Four checks make P9 yours: a workspace folder it can write to, an agent you are signed in to, Mission Control's files${s?.tmux === null ? '' : ' and the terminal'}. About five minutes.</p><p class="muted sm">Skip any time. The Set up card then waits in the Notification Center until every check passes.</p>`
      + (window.p9?.server ? row('Work on another machine?', 'Use this window on another machine\'s P9 over ssh (the way VS Code Remote-SSH works). If that machine has no P9 yet, connecting offers to install it there. Chats there keep running when you close this window.', '', btn('remote', W.remote ? 'Hide' : 'Connect to a P9 on another machine')) : '')
      + (W.remote ? wizRemote(btn) : '');
  } else if (key === 'workspace') {
    title = 'Your workspace';
    body = row('Folder', `<span class="mono" id="welWs">${esc(s.workspace)}</span>`, yes(s.writable, 'P9 can write here', 'P9 cannot write here'))
      + `<p class="muted sm">${s.workspaceEmpty ? 'It is empty; the Mission Control step adds starter files. ' : ''}Changing it restarts P9's background service: running chats, scripts and terminals stop.</p>`
      + (window.p9.workspaceChange ? `<div class="set-row">${btn('change', 'Change the folder')}</div>` : '')
      + (s.writable ? '' : fail('workspace-unwritable'))
      + (note?.error ? fail(note.error, note.detail) : '');
  } else if (key === 'pick') {
    // Item 15: which agent, why P9 asks, then Continue puts the CLI P9 ships where its terminals find it (no download, no
    // admin password; a no-op when it is there) and goes on to sign in to the ones picked. D16: always Continue, since a CLI the
    // owner installed may be outside the background service's PATH; when setting up fails, the reason shows and the button
    // goes on without it (chats run on the CLI the adapter ships; only P9 terminals need the launcher).
    title = 'Claude, Codex or both?';
    const on = wizPicked();
    body = '<p data-why>P9\'s chats run on an agent, and you need an account with the one you pick: pick the one you already have.</p>'
      + AGENTS_PICK.map(([a, name, sub]) => row(name, sub, on.includes(a) ? yes(true, 'Picked') : '', btn('choose:' + a, on.includes(a) ? 'Remove' : 'Pick', on.includes(a) ? 'outline' : 'default'))).join('')
      + `<p class="muted sm">Continue sets up ${on.length === 2 ? 'both' : on.length ? AGENTS_PICK.find(([a]) => a === on[0])[1] : 'the one you pick'} from the copy that comes with P9: nothing is downloaded and no admin password is needed. You can add the other one later in Settings → Setup.</p>`
      + (note?.error ? fail(note.error, note.detail) : '');
    next = on.length ? btn('install', note?.error ? 'Continue without it' : 'Continue', 'default') : '<span class="muted sm">Pick one to go on, or Skip.</span>' + btn('install', 'Continue', 'default').replace('<button', '<button disabled');
  } else if (key === 'agents') {
    title = 'Sign in to an agent';
    const shown = W.picked || (AGENTS_PICK.some(([a]) => s[a + 'Cli'] || s[a]) ? wizPicked() : ['claude', 'codex']);
    body = '<p class="muted sm">Chats need at least one agent signed in. Sign in starts the agent\'s own sign-in; in a terminal types the agent\'s own command into a P9 terminal for you to run.</p>'
      + [['claude', 'Claude', 'A Claude account. After you sign in the browser shows a code: paste it here.'], ['codex', 'Codex', 'A ChatGPT account. P9 shows a one-time code to enter on OpenAI\'s sign-in page.']].filter(([a]) => shown.includes(a)).map(([a, name, sub]) => {
        const l = W.login[a] || {}, on = s[a] && W.stale !== a, ended = !on && !l.running && l.exit !== null && l.exit !== undefined;
        // D17: a login that expired still reads as signed in here, so Sign in again is always offered.
        // D8: Codex signs in with a one-time code on OpenAI's page, which P9 opens when asked (nothing opens by itself).
        const device = a === 'codex';
        return row(name, sub, l.running ? `<span class="muted sm">${device ? (l.code ? '' : 'Getting a code…') : 'Waiting for the browser…'}</span>` : on ? yes(true, 'Signed in') : yes(false, '', s[a] ? 'Sign-in expired' : 'Not signed in'),
          l.running ? (l.url ? btn('open:' + a, device ? 'Open the sign-in page' : "Browser didn't open?", device ? 'default' : undefined) : '') + btn('stop:' + a, 'Cancel') : btn('start:' + a, ended ? 'Retry' : on ? 'Sign in again' : 'Sign in', on ? undefined : 'default'))
          + (l.running && device && l.code ? `<div class="set-row" data-device-code><span class="muted sm">Your one-time code, for 15 minutes</span><span class="spacer"></span><code style="font:600 18px ui-monospace,monospace;letter-spacing:.08em;user-select:all">${esc(l.code)}</code></div>` : '')
          + (l.running && W.note[a]?.info ? `<p class="muted sm">${esc(W.note[a].info)}</p>` : '')
          + (l.running && a === 'claude' ? `<div class="set-row"><input data-slot="input" id="welCode" value="${esc(W.code)}" placeholder="Paste the code from the browser" maxlength="512" autocomplete="off" spellcheck="false" aria-label="Sign-in code">${btn('code:claude', 'Send')}</div>` : '')
          + (l.unsupported && !l.running ? '<p class="warn sm">This Codex has no sign-in with a code (P9 was built with Codex 0.159.3, which has one). Use Sign in in a terminal below and follow what Codex prints there.</p>'
            : ended ? `<p class="warn sm">${name} sign-in ended without signing in. Retry starts it again; finish in the browser before closing it.</p>` : '')
          // D8: its own sign-in command in a P9 terminal, run by the CLI P9 ships (item 15). Nothing runs before Enter.
          + (s[a + 'Cli'] && !on && !l.running ? `<div class="set-row"><span class="muted sm">Or sign in with ${name}'s own command in a P9 terminal.</span><span class="spacer"></span>${btn('term:' + a + ':login', 'Sign in in a terminal')}</div>` : '')
          + (W.note[a]?.error ? fail(W.note[a].error, W.note[a].detail) : '');
      }).join('');
    if (!d.agents) next = '<span class="muted sm">Sign in to one to go on, or Skip.</span>' + btn('next', 'Next', 'default').replace('<button', '<button disabled');
  } else if (key === 'mission') {
    title = 'Mission Control';
    // A folder with things in it keeps them (needs-done p9-wizard-respects-existing-workspace): the paths are what P9 found
    // there, shown and editable, and the list says exactly what Create adds. Nothing that is there is replaced.
    const choosing = wizChoosing(s), paths = wizPaths(), found = Object.keys(s.found || {}).length;
    const starters = d.mission ? [] : (s.creates || []).filter(Boolean), creates = [...starters, ...(d.mission || s.settingsPresent ? [] : [s.settingsFile])].filter(Boolean);
    // RH2 (the owner, 2026-10-24: B, and how to set them up when there are none yet).
    const none = choosing && !found && !s.settingsPresent;
    body = `<p class="muted sm">Mission Control is P9's control room: buttons for your scripts, shortcuts to your apps and pages, and a list of what is waiting on you. Mission Control's buttons, apps and pages come from files in your workspace. ${choosing ? (found ? 'P9 found these in your workspace and will use them; change any path first if you like.' : 'These are the paths P9 will use; change any first if you like.') : 'The paths come from your settings file.'} A file that is already there is never changed or replaced.</p>`
      + (none ? '<div class="sm" data-setup-help><p>None of these is here yet. Create the starter files makes an empty set you can change any time:</p><ul>'
        + '<li><strong>Main project file</strong>: names your main project, in plain words. Your agents read it; Mission Control shows it as the Main Project card.</li>'
        + '<li><strong>Buttons, apps and pages file</strong>: your buttons, apps and pages, each a title and the command or link it opens. Your agent can write it for you.</li>'
        + '<li><strong>Folder of items waiting on you</strong>: one .md file for each thing waiting on you.</li></ul>'
        + (window.p9.openDocs ? `<div class="set-row">${btn('docs', 'How to add buttons')}</div>` : '') + '</div>' : '')
      + (choosing ? '<div class="wiz-paths">' + PATH_KEYS.map(([k, name, kind]) =>`<label class="set-row"><span><strong>${esc(name)}</strong></span><span class="spacer"></span><input data-slot="input" class="mono" data-path="${k}" value="${esc(paths[k] || '')}" maxlength="400" autocomplete="off" spellcheck="false">${window.p9.pickFolder && kind ? btn('pick:' + k + ':' + kind, 'Pick') : ''}</label>`).join('') + '</div>'
        + (s.pathsInvalid ? fail('paths-invalid') : '') : '')
      + row('Settings file', `<span class="mono" id="welFile">${esc(s.settingsFile || '')}</span>`, yes(s.settings, 'Loaded', s.settingsInvalid ? 'Has an error' : s.settingsPresent ? 'Found, not loaded yet' : 'Not found'))
      + row('Mission Control files', 'Your main project file and your buttons, apps and pages file', yes(s.agentsFile && s.registryFile, 'There', 'Not there yet'))
      + (creates.length ? `<p class="sm">${starters.length ? 'Create the starter files' : 'Use these files'} adds only this (nothing that exists changes): <span class="mono" data-creates>${creates.map(esc).join(', ')}</span></p>` : '')
      + (s.conflict ? `<p class="sm" data-conflict>This folder has its own files (${Object.values(s.found).map(esc).join(', ')}) that your settings file does not name. The paths above are what P9 found; change any, then press Use these files. Your old settings file is kept as settings.json.bak.</p>` : '')
      + (s.settingsInvalid ? fail('settings-invalid', s.settingsError) : d.mission || (choosing && s.pathsInvalid) ? '' : `<div class="set-row">${btn('starter', starters.length ? 'Create the starter files' : 'Use these files', 'default')}<span class="muted sm">${starters.length ? 'Makes the files listed above, empty, and points P9 at them.' : 'Makes no project files; it only saves the settings so P9 uses the files named above.'}</span></div>`)
      + (note?.created?.length ? `<p class="ok sm">Created: ${note.created.map(esc).join(', ')}</p>` : '')
      + (note?.error ? fail(note.error, note.detail) : '')
      + (settings.focus.mission && (settings.focus.chat || settings.focus.dev) ? `<div class="set-row">${btn('mission-off', 'Turn Mission off for now')}</div>` : '');
  } else if (key === 'terminal') {
    // Item 15 (threat model row 61): what P9 cannot carry. The reason comes first, then why it needs the admin password,
    // then the command; Run in a terminal types it into a P9 terminal and sudo asks there. tmux cannot: P9's terminals are tmux.
    const admin = (s.dependencies || []).filter(x => x.admin);
    title = admin.length ? 'This needs your admin password' : 'Terminal';
    body = admin.length ? admin.map(x => `<div class="wiz-admin" data-admin="${esc(x.id)}">${row(ADMIN_NAMES[x.id] || esc(x.id), esc(x.why), yes(false, '', 'Not installed'))}`
        + '<p class="sm" data-admin-why>Everything else P9 needs comes with it or goes into your own folders. This one goes into the system itself, and only an admin can change that, so your computer asks for your password.</p>'
        + (x.command ? `<div class="set-row"><code class="mono" data-command>${esc(x.command)}</code><span class="spacer"></span>`
          + (x.id === 'tmux' ? btn('copy:' + x.id, 'Copy') + '</div><p class="muted sm">P9\'s terminals need tmux, so run it in your own terminal app, then Retry.</p>'
            : btn('admin:' + x.id, 'Run in a terminal') + '</div><p class="muted sm">Types it into a P9 terminal. Read it, press Enter, then type your password there.</p>')
          : '<p class="muted sm">Install it with your system\'s package manager, then Retry.</p>')
        + (W.note[x.id]?.error ? fail(W.note[x.id].error, W.note[x.id].detail) : '') + '</div>').join('') + `<div class="set-row">${btn('retry', 'Retry')}</div>`
      : row('tmux', 'The terminal dock runs real shells in tmux.', yes(s.tmux, 'Found', 'Not found')) + (s.tmux ? '' : fail('tmux-not-found'));
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
  if (act === 'docs') return window.p9.openDocs('buttons-apps-and-pages').catch(() => {}); // RH2
  if (act === 'remote' || act === 'remote-retry') { W.remote = act === 'remote-retry' || !W.remote; if (W.remote) W.hosts = await window.p9.server().catch(() => null); return wizRender(); }
  if (act === 'connect') {
    const host = $('#welHost')?.value;
    const r = await run(() => window.p9.server(host).catch(() => ({ error: 'ipc-refused' }))); // main reloads the window onto that P9
    W.note.remote = r?.ok ? null : { error: r?.error || 'refused' };
    return wizRender();
  }
  if (act === 'tour') { W.then = tour; return $('#welDlg').close(); }
  if (act === 'pets') { W.then = null; $('#welDlg').close(); await $('#setBtn').onclick(); return [...$('#setBody').querySelectorAll('legend')].find(l => l.textContent === 'Pets')?.scrollIntoView(); }
  if (act === 'retry') W.note = {};
  if (act === 'change') {
    const r = await run(() => window.p9.workspaceChange().catch(() => ({ error: 'daemon-unavailable' })));
    W.note.workspace = r.error ? r : null;
    if (!r.error) { W.paths = null; files.dirs = {}; renderTree(); loadMission(); } // the tree and Mission show the new folder; paths typed for the old folder are dropped
  }
  if (act === 'pick') {
    const picked = await window.p9.pickFolder(kind).catch(() => undefined);
    if (picked === null || picked === '') W.note.mission = { error: picked === '' ? 'pick-root' : 'pick-outside' }; // BL6
    else if (picked !== undefined) { W.paths = { ...wizPaths(), [agent]: picked }; W.note.mission = null; }
  }
  if (act === 'starter') {
    const body = wizChoosing(W.s) ? wizPaths() : {};
    const r = await run(() => liveChat.call('starter', body).catch(() => ({ status: 503, body: { error: 'daemon-unavailable' } })));
    W.note.mission = r.status === 201 ? { created: r.body.created } : { error: r.body?.error || String(r.status), detail: r.body?.detail };
    if (r.status === 201) { files.dirs = {}; renderTree(); loadMission(); }
  }
  // choose, not pick: pick is the folder picker's.
  if (act === 'choose') { const on = wizPicked(); W.picked = on.includes(agent) ? on.filter(a => a !== agent) : [...on, agent]; W.note.pick = null; return wizRender(); }
  if (act === 'install') {
    if (W.note.pick?.error || wizReady()) { W.note.pick = null; W.i += 1; return wizRender(); }
    const on = wizPicked();
    const r = await run(() => liveChat.call('installAgents', { claude: on.includes('claude'), codex: on.includes('codex') }).catch(() => ({ status: 503, body: { error: 'daemon-unavailable' } })));
    W.picked = on;
    W.note.pick = r.status === 200 ? null : { error: r.body?.error || String(r.status), detail: r.body?.detail };
    if (r.status === 200) W.i += 1;
  }
  if (act === 'copy') { const x = W.s?.dependencies?.find(d => d.id === agent); if (x?.command) copy(x.command, b); return; }
  if (act === 'admin') {
    const r = await run(() => liveChat.call('adminTerminal', { id: agent }).catch(() => ({ status: 503, body: { error: 'daemon-unavailable' } })));
    if (r.body?.terminal) { W.then = () => showTerminal(r.body.terminal); return $('#welDlg').close(); }
    W.note[agent] = { error: r.body?.error || String(r.status), detail: r.body?.command ? 'Run it yourself in a terminal: ' + r.body.command : '' };
  }
  if (act === 'term') {
    const r = await run(() => liveChat.call('agentTerminal', { agent, action: kind }).catch(() => ({ status: 503, body: { error: 'daemon-unavailable' } })));
    if (r.body?.terminal) { W.then = () => showTerminal(r.body.terminal); return $('#welDlg').close(); }
    W.note[agent] = { error: r.body?.error || String(r.status), detail: r.body?.command ? 'Run it yourself in a terminal: ' + r.body.command : '' };
  }
  if (['start', 'open', 'code', 'stop'].includes(act)) {
    const r = await run(() => (act === 'code' ? window.p9.agentLogin('code', agent, W.code.trim()) : window.p9.agentLogin(act, agent)).catch(() => ({ status: 503, body: { error: 'daemon-unavailable' } })));
    // D8: the window says a page opened only when main opened it.
    W.note[agent] = r.status >= 400 ? { error: r.body?.error || String(r.status) } : act === 'open' && r.body?.opened ? { info: 'Opened the sign-in page in your browser. Sign in there, then enter the code.' } : null;
    if (act === 'code' && r.status < 400) W.code = '';
    if (act === 'start' && r.status < 400) { W.began = agent; for (const ms of [1500, 4000]) setTimeout(wizRefresh, ms); } // the page and code come a moment after
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
  // The connecting screen already says why a remote does not answer, so a chat call failing under it raises no toast.
  if (r.status >= 400 && !$('#connecting')?.open && !(action === 'prompt' && r.body?.error === 'turn-running') && !(action === 'cancel' && r.body?.error === 'no-turn')) toast({ kind: 'chat', txt: 'Chat ' + action + ': ' + (r.body?.error || r.status), level: 'bad' }, true);
  return r;
};
liveChat.create = async (agent, folder = '') => {
  const r = await liveChat.call('create', { provider: agent, ...(folder && { folder }) });
  if (r.status === 201 && folder) try { localStorage.setItem('eh-chat-folders', JSON.stringify([folder, ...recentFolders().filter(f => f !== folder)].slice(0, 5))); } catch {}
  return r;
};
// Builder, 2026-10-21: a refused prompt puts its text back in the box as well as its images, so nothing typed is lost.
// 2026-10-24: one refused because a turn runs is queued instead, and shown and kept as queued.
liveChat.prompt = async (s, text, images = [], when) => { s.working = true; s.done = false; renderTabs(); renderChats(); const r = await liveChat.call('prompt', { id: s.id, text, mode: s.mode, ...(when && { when }),...(s.modelPick && { model: s.modelPick }), ...(Object.keys(s.pick || {}).length && { config: s.pick }), ...(images.length && { images: images.map(({ mimeType, data }) => ({ mimeType, data })) }) }); if (r.status === 202) return; s.images = [...images, ...(s.images || [])].slice(0, 4);
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
liveChat.stop = (s, close) => { s.state = 'stopping'; renderTabs(); renderChats(); return liveChat.call('stop', { id: s.id, ...(close && { close }) }); };
const chatModel = { claude: 'Claude Code · ACP', codex: 'Codex · ACP' };
const textLines = t => typeof t === 'string' && t ? t.replace(/\n$/, '').split('\n') : [];
const toolDiff = content => { const rows = (content || []).filter(c => c.type === 'diff').flatMap(c => lineDiff(textLines(c.oldText), textLines(c.newText))).slice(0, 200); return rows.length ? rows : null; };
// PH1: the phone link for this chat, on the daemon's own remote address (its --remote-origin, none with remote logins off).
async function continueOnPhone(s) {
  const r = await window.p9?.chat?.('missionFiles', {}).catch(() => null);
  $('#phoneBody').innerHTML = phoneDialogBody(r?.status === 200 ? r.body.remoteOrigin : '', s.id);
  $('#phoneDlg').showModal();
}
// A chat picture opens large in its own dialog (top layer, above #mdl); a click anywhere or Esc closes it.
const picDlg = $('#picDlg');
addEventListener('click', e => {
  const i = e.target.closest?.('.user-imgs img[src], .agent-imgs img'); if (!i) return;
  Object.assign(picDlg.firstElementChild, { src: i.src, alt: i.alt }); picDlg.showModal();
});
picDlg.onclick = () => picDlg.close();
// A web link in a reply (made by helpers.mjs mdReply, row 18): the window never navigates, so main opens it in the browser.
addEventListener('click', e => {
  const a = e.target.closest?.('a.link[href]'); if (!a || !window.p9?.openLink) return; // a browser preview follows the link
  e.preventDefault(); window.p9.openLink(a.href).catch(() => toast({ kind: 'link', txt: 'Link not opened', level: 'warn' }, true));
});
const toolText = content => (content || []).filter(c => c.type === 'content' && c.content?.type === 'text').map(c => c.content.text).join('\n').slice(-4000);
// Item 19, plan view: Claude's plan-mode plan (ExitPlanMode: the adapter's "Approve Plan" call, kind switch_mode), kept whole.
const planText = d => d?.kind === 'switch_mode' && (d.content || []).filter(c => c.type === 'content' && c.content?.type === 'text').map(c => c.content.text).join('\n').slice(0, 200000) || undefined;
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
      const r = await window.p9.chat('events', { after, only: [s.id], until, ...(after ? {} : { tail: TAIL }) });
      // ponytail: refused (an ID that is not a UUID, which only a seeded test ledger has) leaves the chat empty, not stuck.
      if (r.status === 400) break;
      if (r.status !== 200) { await new Promise(res => setTimeout(res, 2000)); continue; }
      for (const ev of r.body.events) try { applyChat(ev); } catch {}
      if (r.body.more) { tailed(s, r.body); break; }
      after = r.body.cursor;
      if (r.body.events.length < 500) break;
    }
    s.stub = false; renderTabs(); renderChats();
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
  if (ev.type === 'created') { if (!into && !S.sessions.some(x => x.id === ev.conversation)) S.sessions.push(liveSession(ev.conversation, d.provider, d.title, d.folder, ev.at)); return null; }
  const s = into ?? S.sessions.find(x => x.id === ev.conversation); if (!s) return null;
  // Last used, as the daemon's list counts it (History's order); a stub's older history can load after newer events.
  if (!['stopped', 'closed', 'exited', 'interrupted'].includes(ev.type)) s.used = Math.max(s.used || 0, ev.at);
  const last = s.events[s.events.length - 1], notice = text => s.events.push({ t: 'notice', text });
  const settle = () => { s.working = s.prompted = false; s.pending = null; s.events = s.events.filter(e => e.t !== 'approval' && e.t !== 'question'); };
  switch (ev.type) {
    case 'user': if (typeof d.note === 'string') notice('P9 told the agent: ' + d.note.trim()); s.events.push({ t: 'user', text: d.text, images: d.images, when: new Date(ev.at).toTimeString().slice(0, 5) }); s.state = 'running'; s.working = s.prompted = s.sent = true;
      if (Array.isArray(d.held)) s.held = s.held?.filter(h => !d.held.includes(h.id)); break;
    // CP1: a message the daemon holds for this turn (composer.mjs), and its going back: taken back with its x or by a
    // cancel (loadChat puts the text back in the box), or not sent at all.
    case 'held': (s.held ||= []).push({ id: d.id, text: d.text, when: d.when }); break;
    case 'unheld': s.held = s.held?.filter(h => h.id !== d.id); if (d.why !== 'removed' && d.why !== 'cancelled') notice('Not sent (' + d.why + '): ' + d.text); break;
    case 'connected': notice('Connected over ACP'); s.state = 'running'; s.session = d.session; break;
    case 'resumed': notice('Resumed natively (session/resume)'); s.state = 'running'; s.session = d.session; break;
    case 'moving': settle(); s.state = 'moving'; notice('Moving to the remote: this chat is paused here.'); break;
    case 'moved': s.state = 'moved'; s.movedTo = d.host; notice('Moved to ' + d.host + '. It carries on there: switch to Remote mode (the title-bar badge) and open it.'); break;
    case 'move-failed': s.state = 'stopped'; notice('Not moved' + (d.message ? ': ' + d.message : '.') + ' Send a message to carry on here.'); break;
    case 'moved-in': notice('Moved here from another computer. Send a message to carry on where it left off.'); break;
    case 'handed-off': notice('Handed off: press Enter in the terminal to start Claude Code Remote Control, then open this session in claude.ai or the Claude app. Resume here only after you end it there.'); break;
    case 'card': case 'unpin': applyCard(s, ev.type, d); break; // AR2: pin_card and unpin_card, pinned above the composer
    case 'config': if (Array.isArray(d.model?.options)) { s.models = lastModels[s.agent] = d.model; s.model = d.model.options.find(o => o.value === d.model.current)?.name || s.model; if (s.modelPick === d.model.current) s.modelPick = null; }
      if (Array.isArray(d.pickers)) { s.pickers = lastPickers[s.agent] = d.pickers; for (const p of d.pickers) if (s.pick?.[p.id] === p.current) delete s.pick[p.id]; } break;
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
      } else if (d.sessionUpdate === 'tool_call') s.events.push({ t: 'tool', id: d.toolCallId, status: typeof d.status === 'string' ? d.status : 'pending', title: String(d.title || 'Tool call'), diff: toolDiff(d.content), output: toolText(d.content), images: toolImages(d.content), plan: planText(d) });
      else if (d.sessionUpdate === 'tool_call_update') { const tool = s.events.find(e => e.t === 'tool' && e.id === d.toolCallId); if (tool) { if (typeof d.status === 'string') tool.status = d.status; if (d.title) tool.title = String(d.title); if (d.content) { tool.diff = toolDiff(d.content); tool.output = toolText(d.content); tool.images = toolImages(d.content); } } }
      else if (d.sessionUpdate === 'available_commands_update' && Array.isArray(d.availableCommands)) s.commands = lastCommands[s.agent] = d.availableCommands.slice(0, 1000).map(c => ({ name: String(c?.name ?? ''), desc: String(c?.description ?? '') })).filter(c => c.name);
      else if (d.sessionUpdate === 'session_info_update' && typeof d.title === 'string' && d.title.trim()) s.title = d.title.replace(/\s+/g, ' ').trim().slice(0, 120);
      else if (d.sessionUpdate === 'usage_update' && d.size > 0) { s.context = { used: Number(d.used) || 0, size: Number(d.size) }; if (d._meta?.['_claude/rateLimit']) usageNow(); }
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
    case 'turn-end': settle(); s.lastEnd = ev.at; usageNow(); queueSoon(); if (d.stopReason !== 'end_turn') notice('Turn ended: ' + d.stopReason); return s;
    case 'error': s.events.push({ t: 'error', text: d.message }); s.working = false; break;
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
  const list = async () => { let l; while ((l = await window.p9.chat('list', {})).status !== 200 && !lifetime.signal.aborted) await new Promise(res => setTimeout(res, 2000)); return l.body?.conversations || []; };
  while (!lifetime.signal.aborted) {
    const l = scope ? null : await window.p9.chat('list', {});
    if (l?.status === 200) { listed = l.body.conversations; const ids = listed.filter(c => c.state !== 'stopped' && c.state !== 'moved').map(c => c.id); scope = ids.length <= 100 ? { only: ids } : {}; }
    // P20: the first replay reads each open chat's newest blocks only (tailed, above).
    const tail = replaying && scope?.only && !liveChat.cursor ? { tail: TAIL } : {};
    const r = scope ? await window.p9.chat('events', { after: liveChat.cursor, ...(replaying ? { ...scope, ...tail } : { wait: 8000 }) }) : l;
    // A refused narrowed replay (a listed ID the bridge or daemon will not take) replays everything, as before E2.
    if (r.status === 400 && replaying && scope?.only) { scope = {}; continue; }
    if (r.status !== 200) { if (!liveChat.on && sampleView) return; await new Promise(res => setTimeout(res, liveChat.on ? 2000 : 5000)); continue; }
    if (!liveChat.on) { liveChat.on = true; S.sessions = []; S.open = []; dataNote(); }
    // A tail can leave out a chat's created event, so its tab comes from the list.
    if (r.body.more) for (const c of listed) if (scope.only.includes(c.id) && !S.sessions.some(s => s.id === c.id)) S.sessions.push(liveSession(c.id, c.provider, c.title, c.folder, c.created));
    const ended = [], answered_ = [];
    for (const ev of r.body.events) {
      const created = ev.type === 'created' && !replaying, stub = S.sessions.find(s => s.id === ev.conversation && s.stub);
      if (stub) try { await history(stub, ev.cursor - 1); } catch (e) { console.error('chat history', e); }
      // A malformed stored event is skipped, never thrown: it would fail again on every replay.
      let end = null; try { end = applyChat(ev); } catch { end = null; } if (end) ended.push(end);
      if (created) show(ev.conversation);
      if (ev.type === 'answered') answered_.push(ev.conversation);
      // CP1: a held message taken back goes into the box, as typed (not on replay: the box keeps its own draft).
      // ponytail: its images are not returned; attach them again.
      const back = !replaying && ev.type === 'unheld' && ['removed', 'cancelled'].includes(ev.data?.why) && S.sessions.find(s => s.id === ev.conversation);
      if (back) back.draft = ev.data.text + (back.draft ? '\n' + back.draft : '');
      // Its x in any window takes the tab out of this one too (not on replay, which hides every stopped chat).
      const closed = !replaying && ev.type === 'closed' && S.sessions.find(s => s.id === ev.conversation && !s.hidden);
      if (closed) { closed.hidden = true; untab(closed.id); }
    }
    liveChat.cursor = r.body.cursor;
    if (r.body.more) for (const s of S.sessions) if (scope.only.includes(s.id)) tailed(s, r.body);
    if (replaying && (r.body.more || r.body.events.length < 500)) {
      replaying = false;
      // Tabs keep the order the chats were made in; History sorts by last used.
      const all = (await list()).sort((a, b) => a.created - b.created), have = new Map(S.sessions.map(s => [s.id, s]));
      S.sessions = [...all.map(c => have.get(c.id) || { ...liveSession(c.id, c.provider, c.title, c.folder, c.created), state: c.state, stub: true, sent: c.sent, used: c.used }), ...S.sessions.filter(s => !all.some(c => c.id === s.id))];
      // A chat closed here before 0.1.5 that never started stops now, so other windows drop it too; a running one keeps
      // running (the phone may have resumed it) and gets its tab back.
      for (const s of S.sessions) { s.hidden = s.state === 'stopped' || s.state === 'moved'; if (closedChats.has(s.id) && s.state === 'idle') { s.hidden = true; liveChat.stop(s, true); } }
      closedChats.clear(); localStorage.removeItem('eh-closed-chats');
      if (!S.open.length) S.open = S.sessions.filter(s => !s.hidden).slice(-2).reverse().map(s => s.id);
      // Messages kept from before a restart go now: the daemon takes them into a running turn, or queues them back.
      for (const s of S.sessions) if (s.queue.length && s.state === 'running') turnEnd(s);
      moveReloaded();
    }
    // CP9: a throw here (a paint) used to end this loop, so the chat froze until a restart; log it and keep polling.
    else if (!replaying) try { for (const s of ended) { finished(s); turnEnd(s); } for (const id of answered_) { const s = S.sessions.find(x => x.id === id); if (s && !s.pending) answered(s); } } catch (e) { console.error('chat batch', e); }
    try { renderTabs(); renderChats(new Set(r.body.events.map(ev => ev.conversation))); } catch (e) { console.error('chat paint', e); }
  }
}

/* ---------- Send to server: the black hole and the switch (items 24, 25, specs/move-progress-events.md) ---------- */
// Drawn from main's p9:move stream only; the ledger's moving, moved and move-failed events stay the record. The overlay sits
// over the moving chat's pane, not in it (panes are morphed on every paint), and in its dialog when the pane is in one.
// ponytail: one move drawn at a time; another chat's events while one is drawn are not drawn (its ledger events still show).
const fx = $('#moveFx'), fxSky = createSky($('#moveSky')), moveDlg = $('#moveDlg');
const FX_WHAT = { stopping: () => 'Pausing the chat here…', connecting: h => 'Connecting to ' + h + '…', uploading: h => 'Sending ' + (fxFiles === FX.id ? 'the files and the chat' : 'the chat') + ' to ' + h,
  landing: h => h + ' is setting it up…', syncing: () => 'Waiting for the files…' };
const mb = n => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
// The chat's folder goes first, over P9's tunnel (item 23). A folder that needs a choice shows the Send files prompt before the chat
// is frozen (Builder, 2026-10-27: "Same prompt first"); a Syncthing folder sends none and keeps the wait ("Keep today's wait").
let fxFiles = null; // the chat whose move sends its folder first, for the uploading words
async function sendAway(s) {
  let files = [];
  if (window.p9.xferPlan) {
    const p = await window.p9.xferPlan(s.folder || '').catch(() => ({ error: 'no-answer', message: 'P9 did not answer.' }));
    if (p.error) { s.events.push({ t: 'notice', text: 'Not sent to the remote: ' + (p.message || p.error) }); return renderChats(); }
    if (!p.syncthing.laptop.length && !p.syncthing.server.length) {
      const answer = !p.asked && !p.deletes ? [null, false] : await new Promise(done => {
        xfer.id = p.id;
        xferAsk(p, (choice, deleteToo) => { done([choice, deleteToo]); $('#xferDlg').close(); }, true);
        $('#xferDlg').addEventListener('close', () => done(null), { once: true });
      });
      xfer.id = null;
      if (!answer) return; // Cancel: nothing frozen, nothing sent
      files = [p.id, ...answer];
    }
  }
  fxFiles = files.length ? s.id : null;
  const r = await window.p9.sendToServer(s.id, ...files).catch(() => ({ status: 503, body: { error: 'daemon-unavailable' } }));
  if (r.body?.error === 'limit') return xferRefused(r.body);
  // busy: main is moving it already (a window reloaded mid-move); its events draw it.
  if (r.status !== 200 && !['move-failed', 'busy'].includes(r.body?.error)) { s.events.push({ t: 'notice', text: 'Not sent to the remote: ' + (r.body?.message || r.body?.error || 'no answer') }); renderChats(); }
}
function fxPlace() {
  const pane = [...document.querySelectorAll('.pane[data-id]')].find(p => p.dataset.id === FX.id);
  if (!pane) return;
  // The pull scales and turns the pane about its centre: the centre stays, the size is its layout size (not the shrunk box).
  const home = pane.closest('dialog') || document.body, r = pane.getBoundingClientRect(), w = pane.offsetWidth, h = pane.offsetHeight;
  if (fx.parentElement !== home) home.append(fx);
  Object.assign(fx.style, { left: r.left + r.width / 2 - w / 2 + 'px', top: r.top + r.height / 2 - h / 2 + 'px', width: w + 'px', height: h + 'px' });
}
function fxFrame(now) {
  FX.raf = requestAnimationFrame(fxFrame);
  if (now - FX.drawn < 33) return;
  const dt = FX.drawn ? Math.min(0.1, (now - FX.drawn) / 1000) : 0, k = Math.min(1, (now - FX.t0) / 2400), e = 1 - (1 - k) ** 5;
  FX.drawn = now;
  // The landing intro's ignition (30 -> 22), here driven by the move's percent: the hole draws closer as the chat goes in.
  FX.dist += (30 - 8 * FX.pct / 100 - FX.dist) * Math.min(1, dt * 2);
  FX.spin += dt * (0.8 + FX.pct / 100);
  fxPlace();
  fxSky.size(0.6);
  fxSky.set({ uDist: FX.dist, uShift: 0, uIgnite: e, uStars: e, uDim: 1 - 0.38 * e, uSpin: FX.spin, uTime: now / 1000 });
  fxSky.frame();
}
function fxStart(m) {
  Object.assign(FX, { id: m.id, pull: m.id, host: m.host, t0: performance.now(), drawn: 0, spin: 0, dist: 30, pct: 0 });
  renderChats();
  fx.hidden = false; fxPlace();
  requestAnimationFrame(() => fx.toggleAttribute('data-on', true));
  if (!still && fxSky.ok) FX.raf = requestAnimationFrame(fxFrame);
  // Three missed heartbeats (5 s each): the move is not touched, the label says so.
  FX.tick = setInterval(() => { fxPlace(); if (performance.now() - FX.at > 15000 && !fx.hasAttribute('data-wait')) { fx.toggleAttribute('data-wait', true); $('#moveWhat').textContent = 'Waiting for the remote…'; } }, 1000);
}
function fxEnd() {
  cancelAnimationFrame(FX.raf); clearInterval(FX.tick);
  fx.hidden = true; fx.removeAttribute('data-on'); fx.removeAttribute('data-wait');
  Object.assign(FX, { id: null, pull: null, raf: 0, tick: 0 });
  renderChats();
}
function onMove(m) {
  if (!m?.id || (FX.id && FX.id !== m.id)) return;
  if (!FX.id) fxStart(m);
  FX.at = performance.now(); fx.removeAttribute('data-wait');
  if (Number.isFinite(m.percent)) FX.pct = m.percent;
  $('#moveWhat').textContent = FX_WHAT[m.phase]?.(m.host) || 'Moving the chat to ' + m.host;
  $('.move-bar').style.setProperty('--p', FX.pct + '%'); $('.move-bar').setAttribute('aria-valuenow', FX.pct);
  $('#movePct').textContent = FX.pct + '%';
  $('#moveBytes').textContent = m.bytes?.total ? ' · ' + mb(m.bytes.sent) + ' of ' + mb(m.bytes.total) : '';
  $('#moveCancel').hidden = !['stopping', 'connecting', 'uploading'].includes(m.phase);
  if (m.phase === 'done') afterMove(m);
  // failed: the ledger's move-failed notice says why. unknown: the pane's "press to finish" button stays, with main's words.
  if (m.phase === 'failed') fxEnd();
  if (m.phase === 'unknown') { const s = S.sessions.find(x => x.id === m.id); if (s && m.message) s.events.push({ t: 'notice', text: m.message }); fxEnd(); }
}
$('#moveCancel').onclick = () => { $('#moveCancel').hidden = true; $('#moveWhat').textContent = 'Cancelling…'; window.p9.cancelMove(FX.id).catch(() => {}); };
window.p9?.onMove?.(onMove);
// The server updates itself on connect (item 14, apps/desktop/server-update.mjs): each step as a toast; the end, and a
// server newer than this app, as an alert that stays until opened.
function onServerUpdate(u) {
  if (!u) return;
  const on = 'P9 on ' + u.host, missing = (u.missing ?? []).map(m => m.id + ' (' + m.why + '): ' + m.command).join('; ');
  const why = { 'turn-never-ended': 'a chat\'s turn did not end within 2 hours' }[u.error] ?? u.error;
  const say = {
    downloading: [on + ' is downloading ' + u.version + ' from GitHub Releases.', 'ok'],
    building: [on + ' is building ' + u.version + ' beside the running copy.', 'ok'],
    'waiting-turns': [on + ' will update to ' + u.version + ': waiting for ' + u.turns + ' chat' + (u.turns === 1 ? '' : 's') + ' to finish ' + (u.turns === 1 ? 'its' : 'their') + ' turn.', 'ok'],
    restarting: [on + ' is restarting on ' + u.version + '.', 'ok'],
    done: [on + ' is now ' + u.version + '.', 'ok', true],
    'rolled-back': [on + (u.rolledBack ? ' did not start on ' + u.version + ' and went back to its old copy (' + u.reason + ').' : ' did not start on ' + u.version + ' and could not go back by itself (' + u.reason + '): see journalctl --user -u p9-foundation on the remote.'), 'bad', true],
    failed: [on + ' was not updated to ' + u.version + ' (' + why + '). It runs on as before.', 'bad', true],
    'timed-out': [on + ' did not finish updating to ' + u.version + ' within ' + u.minutes + ' minutes. Connect again to see where it stands.', 'bad', true],
    'too-old': [on + ' runs ' + u.server + ', too old to update itself. Update it once by hand, in a terminal on ' + u.host + ' (from the folder P9 was cloned into):', 'bad', true],
    'app-older': ['The remote runs P9 ' + u.server + '; this app is ' + u.app + '. Update this app (Settings > Updates).', 'bad', true],
    unsupported: [on + ' cannot update itself (it is not a source checkout run by systemd). It stays on ' + u.server + '.', 'bad', true],
  }[u.phase];
  if (!say) return;
  // A remote before 0.1.6 (K1): the steps in a dialog at once, then connect again and it updates itself from then on.
  const steps = u.phase === 'too-old' ? ['git pull', 'pnpm install --frozen-lockfile', 'pnpm build', 'bash scripts/install.sh', 'systemctl --user restart p9-foundation'] : null;
  const a = { kind: 'remote update', txt: say[0] + (missing ? ' Missing on the remote: ' + missing + ' (P9 never runs sudo).' : ''), level: say[1], ...(steps ? { steps, after: 'Then connect again: from 0.1.6 on, it updates itself when you connect.' } : {}) };
  toast(a, !say[2]);
  if (steps) openModal({ kind: 'alert', a });
}
window.p9?.onServerUpdate?.(onServerUpdate);
window.p9?.whatsNew?.().then(w => { if (w) openModal({ kind: 'whats-new', w }); }, () => {});
window.p9?.serverUpdate?.().then(onServerUpdate, () => {});
// "Open it on <host>?" and "Finish the move?": Enter takes the switch from anywhere in the box (a form's Enter would take
// its first button, Stay); Esc is no.
function moveAsk({ title, text, yes, no, never }) {
  $('#moveT').textContent = title; $('#moveP').textContent = text; $('#moveYes').textContent = yes; $('#moveNo').textContent = no;
  $('#moveNeverRow').hidden = !never; $('#moveNever').checked = false;
  moveDlg.returnValue = '';
  moveDlg.showModal();
  return new Promise(done => moveDlg.addEventListener('close', () => done({ yes: moveDlg.returnValue === 'yes', never: !!never && $('#moveNever').checked }), { once: true }));
}
moveDlg.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.matches('button')) { e.preventDefault(); moveDlg.close('yes'); } });
// Item 24. "Don't show again" keeps the answer it was ticked with: always open on the server, or always stay.
async function afterMove(m) {
  let kept = null; try { kept = localStorage.getItem('p9-after-move-ask'); } catch {}
  const pick = kept === 'open' || kept === 'stay' ? { yes: kept === 'open' } : await moveAsk({ title: 'Open it on ' + m.host + '?', yes: 'Open it', no: 'Stay here', never: true,
    text: 'The chat is on ' + m.host + ' now. Opening it switches this window to the remote; your chats on this computer stay here for when you switch back.' });
  if (pick.never) localStorage.setItem('p9-after-move-ask', pick.yes ? 'open' : 'stay');
  if (!pick.yes) return fxEnd();
  localStorage.setItem('p9-after-move', JSON.stringify({ id: m.id }));
  const r = await window.p9.server(m.host).catch(() => null); // main reloads the window onto the remote's P9
  if (!r?.ok) { localStorage.removeItem('p9-after-move'); fxEnd(); const s = S.sessions.find(x => x.id === m.id); s?.events.push({ t: 'notice', text: 'Could not switch to ' + m.host + '. Settings > Remote switches by hand.' }); renderChats(); }
}
// After the first replay. The chat a move took here opens in the pane (on the server it is stopped, here it is moved).
// A chat left moving by a reload: no stream event within 6 s means main is not moving it, so ask to finish.
function moveReloaded() {
  let after = null; try { after = JSON.parse(localStorage.getItem('p9-after-move'))?.id; localStorage.removeItem('p9-after-move'); } catch {}
  const landed = after && S.sessions.find(s => s.id === after && s.state !== 'moved');
  if (landed) focus(landed.id);
  const left = S.sessions.find(s => s.live && s.state === 'moving');
  if (!left || !window.p9?.sendToServer) return;
  setTimeout(async () => {
    if (FX.id || left.state !== 'moving' || serverInfo?.host || moveDlg.open) return;
    const r = await moveAsk({ title: 'Finish the move?', yes: 'Finish the move', no: 'Not now',
      text: '"' + (left.title || 'This chat') + '" was moving to ' + (serverInfo?.last || 'the remote') + ' when the window closed. It stays paused here until the move finishes; its Send to remote button finishes it later.' });
    if (r.yes) sendAway(left);
  }, 6000);
}

addEventListener('focus', () => renderChats());
// Send to server shows only on this computer's chats, so the panes need the mode before Settings is first opened.
if (window.p9?.server) window.p9.server().then(r => { serverInfo = r; renderChats(); renderTree(); serverMenu(); }, () => {});
// The title-bar badge, Remote · host or Local, opens the machine menu: This computer and the Settings > Remote list (D3),
// each with its state; a pick connects at once through the same IPC as Settings' Connect, and a remote without P9 lands on
// the connecting screen's Install (D15a). The remote in use says how its tunnel is; the others saved here or used last are
// probed over ssh as the menu opens (p9:remote-state, threat model row 50, c23 adds), Checking… until each answers.
// ~/.ssh/config hosts never saved or used are not asked.
const SERVER_STATE = { ok: ['ok', 'Connected'], 'server-no-p9': ['warn', 'P9 not running'], 'server-connecting': ['wait', 'Connecting…'], 'server-dropped': ['wait', 'Connecting…'] };
const PROBE_STATE = { p9: ['ok', 'P9 running'], 'no-p9': ['warn', 'P9 not running'], unreachable: ['bad', 'Unreachable'] };
// The remote in use and the last one used come first, even when neither list holds them (the old badge's one click went to last).
const machines = () => { const { host = null, last = null, hosts = [], remotes = [] } = serverInfo ?? {}; return { host, last, remotes, all: [...new Set([host, last, ...remotes, ...hosts])].filter(Boolean) }; };
let serverPop = null;
function serverMenu() {
  const badge = $('#serverBadge'), { host, all } = machines();
  if (!badge || !all.length) return;
  badge.hidden = false; badge.setAttribute('aria-haspopup', 'menu');
  badge.innerHTML = esc(host ? 'Remote · ' + host : 'Local') + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  badge.title = 'This window works on ' + (host || 'this computer') + '. Click to pick another machine.';
  serverPop ??= popover(badge, $('#serverPop'), () => { const pop = $('#serverPop'); pop.style.left = Math.max(8, Math.min(badge.offsetLeft, innerWidth - pop.offsetWidth - 8)) + 'px'; renderServerMenu(); });
}
async function renderServerMenu() {
  const pop = $('#serverPop'), { host, last, remotes, all } = machines(), probed = h => h !== host && (remotes.includes(h) || h === last), s = host ? await window.p9.getStatus().catch(() => ({})) : {};
  const row = (h, [dot, say], current) => '<div class="srv-row"><button class="item" role="menuitem" data-server-go="' + esc(h ?? '') + '"' + (current ? ' aria-current="true"' : '')
    + '><span class="srv-dot" data-s="' + dot + '"></span>' + esc(h ?? 'This computer') + '<span class="muted">' + say + '</span></button>'
    + (h && remotes.includes(h) && !current ? '<button class="srv-x" data-server-rm="' + esc(h) + '" aria-label="Remove ' + esc(h) + '" title="Remove ' + esc(h) + '">×</button>' : '') + '</div>';
  pop.innerHTML = '<div class="hd eyebrow">Work on</div>' + row(null, host ? ['off', ''] : ['ok', 'In use'], !host)
    + all.map(h => row(h, h === host ? SERVER_STATE[s.status === 'ok' ? 'ok' : s.error] ?? ['bad', 'Unreachable'] : probed(h) ? ['wait', 'Checking…'] : ['off', 'Not connected'], h === host)).join('')
    + '<hr data-slot="separator" style="margin:6px 0"><button class="item" role="menuitem" id="serverAdd">Add a machine…</button>';
  pop.querySelectorAll('[data-server-go]').forEach(b => { b.onclick = () => { serverPop.close(); if (b.getAttribute('aria-current') !== 'true') window.p9.server(b.dataset.serverGo || null); }; });
  pop.querySelectorAll('[data-server-rm]').forEach(b => { b.onclick = async () => { const r = await window.p9.remotes('remove', b.dataset.serverRm).catch(() => null); if (r) { serverInfo.remotes = r.remotes; renderServerMenu(); } }; });
  all.filter(probed).forEach(h => window.p9.remoteState?.(h).then(st => {
    const b = pop.querySelector('[data-server-go="' + CSS.escape(h) + '"]'), [dot, say] = PROBE_STATE[st] ?? PROBE_STATE.unreachable;
    if (b) { b.querySelector('.srv-dot').dataset.s = dot; b.querySelector('.muted').textContent = say; }
  }, () => {}));
  $('#serverAdd').onclick = async () => { serverPop.close(); await $('#setBtn').onclick(); $('#setRemote')?.scrollIntoView({ block: 'center' }); $('#setRemoteName')?.focus(); };
}
if (chatOn()) side.open('dan-chat', danChat);
renderMission(); renderTabs(); renderChats(); renderTree(); renderDev(); setFocus('chat', true); loadMission().then(() => setTimeout(pollMission, 20000)); pollUsage(); loadChat(); checkSetup();
addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && e.code === 'KeyN') { e.preventDefault(); mdl.open && S.modal?.kind === 'center' ? closeModal() : openModal({ kind: 'center' }); } });
// mock: the hub's two open alerts arrive a few seconds after load. Sample view only: on the daemon they filled the
// bell with test data (Builder, 2026-10-18); live notices come from loadHub.
if (!window.p9?.mission) M.notifications.forEach((n, i) => setTimeout(() => toast({ ...n }), 2500 + i * 3000));

// Anymouse: DUWOP's idea / bug / gripe box. The desktop main process sends it; the daemon files it or main opens
// GitHub's prefilled page. Only textContent here: nothing the note or GitHub returns becomes markup.
const amDlg = $('#amDlg'), amText = $('#amText'), amNote = $('#amNote'), amSend = $('#amSend'), amCount = $('#amCount'), amWeb = $('#amWeb');
const AM_MAX = 50000; // the daemon's limit (anymouse.mjs MAX_NOTE); a longer note stays in the box, marked, and does not send
let amKind = 'idea';
$('#amBtn').onclick = () => { amNote.textContent = ''; amWeb.hidden = true; amCheck(); amDlg.showModal(); amText.focus(); };
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
// browser: send it the tokenless way (GitHub's prefilled page), offered when GitHub refused the daemon's token.
const amSendNote = async (browser) => {
  amSend.disabled = true; amNote.textContent = '';
  try {
    if (!window.p9?.anymouse) throw new Error('Anymouse needs the desktop app');
    const r = await window.p9.anymouse({ kind: amKind, text: amText.value.trim(), page: S.focus, ...(browser ? { browser } : {}) });
    amWeb.hidden = r.body?.refused !== true;
    if (r.status !== 200) throw new Error(r.body?.error ?? "couldn't send (" + r.status + ')');
    // Opened in the browser: the note stays to copy until the issue is filed there (GitHub issue #4 item 6).
    if (!r.body.opened) amText.value = '';
    amNote.textContent = r.body.opened ? 'Opened GitHub in your browser: finish the issue there. Your note is still here to copy.' + (r.body.cut ? ' It was too long for a link, so GitHub got only the start' + (r.body.kept ? ' (the first ' + r.body.kept.toLocaleString('en-US') + ' of ' + r.body.total.toLocaleString('en-US') + ' characters)' : '') + '; paste the rest from here.' : '') : 'Sent as issue #' + r.body.number + '. Thanks.';
  } catch (err) { amNote.textContent = err.message; }
  finally { amCheck(); }
};
$('#amForm').onsubmit = (e) => { e.preventDefault(); amSendNote(false); };
amWeb.onclick = () => amSendNote(true);

return () => { lifetime.abort(); timers.forEach(window.clearTimeout); observers.forEach(o => o.disconnect()); };
}
