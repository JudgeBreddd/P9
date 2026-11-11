import { chatFailed, popover as createPopover, FILE_IMAGE, fileImageError, fileImageSrc, dragBar, svg, esc, agentWarning, warnHtml, sprintTimes, limitLine, md, mdReply, info, imgSrc, toolImages, agentImgs, readImage, IMG_OK, MAX_IMAGES, modes, LOOSE, copy, copyCode } from './helpers.mjs';
// A choice is [value, label]; the sample data gives plain strings.
const opt = o => Array.isArray(o) ? o : [o, o];
import { DUWOP, shareLook } from './theme-picker';
import { codeColoursVersion, onCodeColours } from './code-colours.mjs';
import { WALKTHROUGH } from './walkthrough.mjs';
import { WHATS_NEW } from './whats-new.mjs';
import { chip, waiting, turnKey, lineDiff } from './composer.mjs';
import { MAINTENANCE, maintenanceGroup } from './maintenance.mjs';
import { PATH_KEYS, missionKeys, missionShown, missionValue } from './mission-files.mjs';
import { SECURITY, warnsLoose, setWarnsLoose, setStarts, unrestricted } from './security.mjs';
import { editorModal, editItems } from './mission-editor.mjs';
import { tileHtml, tileLevel, linkHtml, tileAnswer, quickNotePath, quickNoteHtml, quickNoteWords } from './data-tiles.mjs';
import { checklistHtml, checklistAction, checklistAnswer } from './checklist.mjs';
import { onboardCard, templateWords, previewCard, freeName } from './onboarding.mjs';
import { createSky } from './landing-sky.mjs';
import { mountLandingVideo } from './components/landing-v5/playback.mjs';
import landPoster from './components/landing-v5/black-hole.webp?url';
import landLoop from './components/landing-v5/rendered/horizon-loop.mp4?url';
import './components/landing-v5/background.css';
import { phoneDialogBody } from './phone-link.mjs';
import { pinned, applyCard } from './pinned.mjs';
import { createSide } from './side.mjs';
import { PARTS, partOrder } from '../../../packages/protocol/index.mjs';
import { artifactView, artifactsIn, chipArtifact, mountCard, KIND_NAMES } from './artifact.mjs';
import { installMission } from './mission-view.mjs';
import { installChat } from './chat-view.mjs';
import { installPanel } from './panel.mjs';
import { installSettings } from './settings-view.mjs';
import { installCards } from './cards-modal.mjs';
import { installFiles } from './files-view.mjs';
import { installLanding } from './landing-move.mjs';

// The admin password window (Shell.tsx, row I2), for row 61 on a remote.
let adminAsk = null;
export function mountShell({ askAdmin } = {}) {
  // outer: mountShell's names that the modules split out of it (F9) read and set; getters and setters keep them live.
  const outer = { get $() { return $; }, get CTP() { return CTP; }, get FRAME() { return FRAME; }, get FX() { return FX; }, get IND() { return IND; },
    get LAND() { return LAND; }, get LAND_BG() { return LAND_BG; }, get M() { return M; }, get PET_ROLES() { return PET_ROLES; }, get S() { return S; },
    get SKY_MAIN() { return SKY_MAIN; }, get SP() { return SP; }, get WIZ_ERR() { return WIZ_ERR; }, get XFER_SETTINGS() { return XFER_SETTINGS; },
    get addHalos() { return addHalos; }, get agentLock() { return agentLock; }, set agentLock(v) { agentLock = v; }, get attrs() { return attrs; },
    get bottoms() { return bottoms; }, get busy() { return busy; }, get cardList() { return cardList; }, get chatImgs() { return chatImgs; },
    get chatOn() { return chatOn; }, get closeModal() { return closeModal; }, get closedChats() { return closedChats; },
    get danChat() { return danChat; }, get dataNote() { return dataNote; }, get defaultMode() { return defaultMode; }, get dirty() { return dirty; },
    get edSave() { return edSave; }, set edSave(v) { edSave = v; }, get editorHtml() { return editorHtml; },
    get fileProtect() { return fileProtect; }, set fileProtect(v) { fileProtect = v; }, get files() { return files; }, get focus() { return focus; },
    get focusNames() { return focusNames; }, get focusOn() { return focusOn; }, get fx() { return fx; },
    get fxFiles() { return fxFiles; }, set fxFiles(v) { fxFiles = v; }, get fxSky() { return fxSky; },
    get guide() { return guide; }, set guide(v) { guide = v; }, get hideSteps() { return hideSteps; }, set hideSteps(v) { hideSteps = v; },
    get land() { return land; }, get landOn() { return landOn; }, get landVideo() { return landVideo; },
    get lastArt() { return lastArt; }, set lastArt(v) { lastArt = v; }, get lastCards() { return lastCards; }, set lastCards(v) { lastCards = v; },
    get lastCommands() { return lastCommands; }, get lastModels() { return lastModels; }, get takeLists() { return takeLists; }, get refreshDefaults() { return refreshDefaults; }, get newRows() { return newRows; }, get newLists() { return newLists; }, get listsAt() { return listsAt; }, get listState() { return listState; }, get listDef() { return listDef; }, get isDefault() { return isDefault; },
    get pickerKind() { return pickerKind; }, get defaultModel() { return defaultModel; }, get defaultEffort() { return defaultEffort; },
    get claimFresh() { return claimFresh; }, get startDefaults() { return startDefaults; }, get usedAgent() { return usedAgent; },
    get lastOverview() { return lastOverview; }, set lastOverview(v) { lastOverview = v; }, get lastPickers() { return lastPickers; },
    get leave() { return leave; }, get lifetime() { return lifetime; }, get live() { return live; }, get liveChat() { return liveChat; },
    get loadMission() { return loadMission; }, get loadPetLook() { return loadPetLook; }, get loadSetup() { return loadSetup; },
    get looseOk() { return looseOk; }, get maintain() { return maintain; }, get mdOf() { return mdOf; }, get mdl() { return mdl; },
    get mirror() { return mirror; }, get missionFiles() { return missionFiles; }, set missionFiles(v) { missionFiles = v; },
    get missionLive() { return missionLive; }, get modals() { return modals; }, get morph() { return morph; },
    get moveDlg() { return moveDlg; }, get moveReloaded() { return moveReloaded; }, get names() { return names; },
    get needsLabel() { return needsLabel; }, get newFolder() { return newFolder; }, get noteModal() { return noteModal; },
    get observe() { return observe; }, get openModal() { return openModal; }, get opt() { return opt; }, get petCanvas() { return petCanvas; },
    get petLook() { return petLook; }, get petMode() { return petMode; }, set petMode(v) { petMode = v; }, get petSpots() { return petSpots; },
    get petTimer() { return petTimer; }, set petTimer(v) { petTimer = v; }, get pets() { return pets; }, set pets(v) { pets = v; },
    get pickRemoteFolder() { return pickRemoteFolder; }, get popover() { return popover; }, get openPal() { return openPal; }, get placeDev() { return placeDev; }, get newPop() { return newPop; }, get loadProjects() { return panel.loadProjects; },
    get queueSoon() { return queueSoon; }, get queueTimer() { return queueTimer; }, set queueTimer(v) { queueTimer = v; },
    get renderCards() { return renderCards; }, get renderChats() { return renderChats; }, get renderMission() { return renderMission; },
    get renderModal() { return renderModal; }, get renderSideChat() { return renderSideChat; }, get renderTabs() { return renderTabs; },
    get renderTree() { return renderTree; }, get restartP9() { return restartP9; }, get reviewSort() { return reviewSort; },
    get sampleView() { return sampleView; }, get saveBtn() { return saveBtn; }, get saveWhy() { return saveWhy; },
    get serverInfo() { return serverInfo; }, get serverMenu() { return serverMenu; }, get setFocus() { return setFocus; },
    get setHTML() { return setHTML; }, get setPage() { return setPage; }, set setPage(v) { setPage = v; }, get setSideChat() { return setSideChat; },
    get setTimeout() { return setTimeout; }, get settings() { return settings; }, set settings(v) { settings = v; },
    get settingsAt() { return settingsAt; }, get setupMode() { return setupMode; }, set setupMode(v) { setupMode = v; },
    get showTerminal() { return showTerminal; }, get side() { return side; }, get sideSession() { return sideSession; },
    get skipWelcome() { return skipWelcome; }, get sky() { return sky; }, get spaceForm() { return spaceForm; }, set spaceForm(v) { spaceForm = v; },
    get spaceMenuHtml() { return spaceMenuHtml; }, set spaceMenuHtml(v) { spaceMenuHtml = v; },
    get spacePop() { return spacePop; }, set spacePop(v) { spacePop = v; }, get startMode() { return startMode; },
    get startTurn() { return startTurn; }, get still() { return still; }, get sync() { return sync; },
    get termGreeting() { return termGreeting; }, set termGreeting(v) { termGreeting = v; }, get tickPets() { return tickPets; },
    get toast() { return toast; }, get topAt() { return topAt; }, set topAt(v) { topAt = v; }, get tree() { return tree; },
    get updates() { return updates; }, set updates(v) { updates = v; },
    get updatesTimer() { return updatesTimer; }, set updatesTimer(v) { updatesTimer = v; }, get usage() { return usage; },
    get usageNow() { return usageNow; }, get usageRows() { return usageRows; },
    get usageSoon() { return usageSoon; }, set usageSoon(v) { usageSoon = v; }, get view() { return view; }, get walkthrough() { return walkthrough; },
    get welcome() { return welcome; }, get winTop() { return winTop; }, get wins() { return wins; }, get wireEditor() { return wireEditor; },
    get wiredBars() { return wiredBars; }, get wizPicked() { return wizPicked; }, get wizRender() { return wizRender; },
    get written() { return written; }, get xfer() { return xfer; }, get xferAsk() { return xferAsk; }, get xferRefused() { return xferRefused; } };
  const { pullTopLevels, usage, loadUsage, pollUsage, usageNow, restartBtn, restartP9, loadMission, refreshMission, pollMission, queueSoon, noticeLine, listRow, answerLive, widgetOn, allNotes, usageBody, art, launchTile, winTop, winPanel, NEEDS, placed, placedCols, placedHtml, topRow, byFile, missionEmpty, missionIntro, loadGuide, renderSpaceBtn, bindOnboard, missionLive, noteKey, liveFileModal, noteFoot, saveNote, missionModal } = installMission(outer);
  const { ART, keepBox, focus, show, stopChat, newSession, pickRemoteFolder, recentFolders, renderNewFolder, usageRows, cacheOf, busy, renderChats, paint, turnEnd, reply, dataNote, linkOk, keepQueue, history, loadChat } = installChat(outer);
  onCodeColours(() => renderChats()); // O37: a parser arrived, so the open chats redraw once with colours
  const { saveSettings, applySettings, settingsAt, renderSettings, refreshDefaults, loadSetup, setupDone, welSkipped, AGENTS_PICK, wizPicked, wizReady, ADMIN_NAMES, STEP_NAMES, checkSetup, skipWelcome, tour, firstRun, W, wizPaths, wizChoosing, wizSteps, welcome, wizRefresh, WIZ_ERR, wizRemote } = installSettings(outer);
  const { PET_ROLES, DEFAULT_PET, petLook, loadPetLook, renderIndicator, petCanvas, tickPets, petBox, cardAct, cardsOverlay, renderCards, sizes, groupOf, openModal, closeModal, outside, askNow, toast, raiseToasts } = installCards(outer);
  const { renderTree, XFER_SETTINGS, bytes, xfer, xferRefused, sendFiles, xferAsk, doc, dirty, editorHtml, wireEditor, saveWhy, saveDoc, saveBtn, renderModalFoot } = installFiles(outer);
  const { NO_SKY, lastFocus, landingStart, openLanding, landMain, leaveLanding, leave, onMove, moveReloaded, SERVER_STATE } = installLanding(outer);
  adminAsk = askAdmin ?? null;
// The sample data lives in the test folder and never ships (the owner, 2026-10-20: "sample data should not be in the app at all").
// Only the UI tests hand it in, through the desktop bridge (P9_SAMPLE_DATA, unpackaged only). Everywhere else the lists start
// empty and fill from the daemon (GitHub issue #4: a fresh Windows install showed the sample items, and so did a dead daemon).
const sampleView = !!window.p9?.sample;
const M = sampleView ? structuredClone(window.p9.sample) : { sessions: [], history: [], files: [], fileBody: {}, queue: [], notifications: [],
  apps: [], tools: [], pages: [], scripts: {}, terminal: [], outputs: {}, space: [] };
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
// Each agent's last model, picker and command lists, so a new chat has them before its own session starts.
// O47: the model and picker lists are the daemon's (GET /chat's lists: what a running agent last reported there, read
// fresh once per daemon run with no chat), so each P9 this window talks to has its own, and they outlive a restart.
// listsAt: when the kept list was reported; only a newer report replaces it (takeLists, newLists), so replaying an old
// chat never puts an old list back. listState: 'loading' | 'ok' | 'failed' | 'kept'. listDef (MC-16): what a new
// session of that agent starts on, { model, pickers: { id: value } }.
const lastModels = {}, lastCommands = {}, lastPickers = {}, listsAt = {}, listState = {}, listDef = {};
for (const a of Object.keys(modes)) for (const k of ['models', 'pickers']) try { localStorage.removeItem(`p9-${k}:` + a); } catch {} // 0.1.8's per-computer copy, which mixed this P9's lists with a remote's
function takeLists(lists) {
  let loading = false;
  for (const a of Object.keys(modes)) { const l = lists?.[a]; if (!l) continue;
    listState[a] = l.state; loading ||= l.state === 'loading'; if (l.def) listDef[a] = l.def;
    if (Array.isArray(l.model?.options) && l.at >= (listsAt[a] || 0)) { lastModels[a] = l.model; lastPickers[a] = Array.isArray(l.pickers) ? l.pickers : []; listsAt[a] = l.at; } }
  return loading;
}
// A chat's own report (a 'config' event): kept as the agent's list only when it is newer than the one held.
const newLists = (a, at, model, pickers) => { if (!(at >= (listsAt[a] || 0))) return; listsAt[a] = at; if (model) lastModels[a] = model; if (pickers) lastPickers[a] = pickers; };
const isDefault = (a, id, v) => v !== undefined && (id === null ? listDef[a]?.model : listDef[a]?.pickers?.[id]) === v;
// The agent's other settings (threat model row 22), told apart by category: Effort (thought_level), Fast mode (model_config, in
// the Model menu) and Codex's plan switch (collaboration_mode, the Mode menu's Plan). A list without categories (an older
// daemon on a remote) goes by name. The chat bar's pills that read them are in chat-view.mjs.
const pickerKind = p => p.category === 'thought_level' || !p.category && /effort|thought/i.test(p.id + p.name) ? 'effort' : p.category === 'collaboration_mode' || !p.category && /collab/i.test(p.id) ? 'collab' : 'model';
// Settings > New chats start in: Default model and Default effort per agent, applied to chats this window makes (startDefaults)
// when the agent still offers them; a chat's own pick never changes them. fresh: the chats this window is creating, each
// { agent, model: its New menu row's, op: the create's operation ID, id once known }. The daemon sends 'created' (carrying op)
// before it answers the create, so claimFresh runs from whichever comes first and applies the pick once; a pick made in the chat
// after that is never overwritten. Only op or id match: another window's chat, or this window's creates out of order, never take
// it (O44 review). A daemon without op in 'created' leaves it to the reply.
const defaultModel = a => localStorage.getItem('p9-model-default:' + a) || '', defaultEffort = a => localStorage.getItem('p9-effort-default:' + a) || '';
const fresh = [];
function claimFresh(s, op) {
  const i = fresh.findIndex(f => f.id === s.id || op && f.op === op); if (i < 0) return;
  const [f] = fresh.splice(i, 1); f.id = s.id; startDefaults(s, f.model);
}
function startDefaults(s, model) {
  const m = [model, defaultModel(s.agent)].find(v => v && lastModels[s.agent]?.options.some(o => o.value === v)); if (m) s.modelPick = m; // model: the New menu row's (O44); one no longer offered falls back
  const e = defaultEffort(s.agent), p = lastPickers[s.agent]?.find(x => pickerKind(x) === 'effort'); if (e && p?.options.some(o => o.value === e)) (s.pick ||= {})[p.id] = e;
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
// O29: the agent used last here. ponytail: per computer, like the last mode (p9-mode:); a second device keeps its own.
const lastAgent = () => { const a = localStorage.getItem('p9-agent-last'); return names[a] ? a : 'claude'; };
const usedAgent = a => { try { localStorage.setItem('p9-agent-last', a); } catch {} };
// The side panel (side.mjs). Dev Focus: the chat beside the editor (item 18), on by default, on the right until its tab is dragged across.
const side = createSide({ el: $('#side'), stage: $('.stage'), focus: () => S.focus, signal: lifetime.signal });
const chatOn = () => localStorage.getItem('eh-dan-chat:dev') === 'on'; // off until turned on (the owner, attempt 2 item 4)
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
  bars: ic('<path d="M6 20v-6"/><path d="M12 20V4"/><path d="M18 20v-10"/>'),
  gauge: ic('<path d="m12 14 4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>'),
  clock: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  bell: ic('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'),
  bot: ic('<path d="M12 4v3"/><circle cx="12" cy="3" r="1"/><rect x="4" y="7" width="16" height="13" rx="3"/><circle cx="9" cy="13" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.4" fill="currentColor" stroke="none"/><path d="M9.5 17h5M2 12v3M22 12v3"/>'),
});
for (const [id, k] of [['rChat','chat'],['rDev','code'],['rMission','gauge'],['rBell','bell'],['newBtn','plus'],['stopAll','stop'],['rTerm','term'],['rUsage','bars'],['rCmd','cmd'],['themeBtn','palette'],['setBtn','gear'],['dFloat','float'],['dHide','x'],['sideToggle','chat']]) $('#'+id).insertAdjacentHTML('afterbegin', svg[k]); // afterbegin: the panel's labels stay

/* ---------- the left panel (panel.mjs): the chat switcher, in place of the tab row, History and the rail's robot heads ---------- */
const panel = installPanel(outer, { focus, stopChat, busy });
function renderTabs() {
  panel.renderPanel();
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
  // he skips, wait quietly in the Notification Center. Running chats are robot heads in the panel (panel.mjs).
  const fresh = S.reviews.filter(r => !S.quiet.has(r.file)), old = S.reviews.length - fresh.length;
  if (fresh.length) cards.push({ key: 'reviews:' + fresh.map(r => r.file).join(), halo: true, n: fresh.length, title: fresh.length === 1 ? '1 item needs you' : fresh.length + ' items need you', sub: (live.waiting || 'waiting') + '/ · ' + fresh[0].proj, open: fresh.length === 1 ? { kind: 'review', i: S.reviews.indexOf(fresh[0]) } : { kind: 'reviews' } });
  if (old) cards.push({ key: 'waiting', quiet: true, n: old, title: (old === 1 ? '1 item' : old + ' items') + ' in ' + (live.waiting || 'waiting') + '/' /* the user's own folder name (settings.waiting) */, sub: 'waiting', open: { kind: 'reviews' } });
  for (const s of S.sessions.filter(x => x.done)) cards.push({ key: 'done:' + s.id, id: s.id, halo: true, agent: s.agent, title: names[s.agent] + ' finished', sub: s.title, open: { kind: 'chat', id: s.id } });
  if (S.setup) { const d = setupDone(S.setup), rows = Object.keys(d).filter(k => k !== 'pick' && k !== 'mission' && (k !== 'terminal' || S.setup.tmux !== null)), left = rows.filter(k => !d[k]); cards.push({ key: 'welcome', quiet: welSkipped(), n: left.length, title: `Set up · ${rows.length - left.length} of ${rows.length} done`, sub: [...left.map(k => STEP_NAMES[k]), ...(d.mission ? [] : ['Mission Control'])].join(' · ') }); }
  return all ? cards : cards.filter(c => !c.quiet && !S.snoozed.has(c.key));
}
/* ---------- agent-working indicator and pets (phase 18; Builder's pet requests, 2026-10-17) ---------- */
// The top bar says when agents work or wait on you, in every focus, with Claude Code's spinner. Where a focus shows pets
// (Settings, one set per focus), each active agent's pet takes that text's place (see renderIndicator) and every chat on
// screen holds its agent's pet (petRows). A chat's pet drags anywhere in it; the spot is kept per focus. A sheet is 8 x 9 frames of
// 192 x 208: row 0 idle, 3 wave, 4 jump, 6 waiting, 7 running; each row's frame count is read from the sheet.
const IND = { glyphs: '·✢✳✶✻✽✻✶✳✢', looks: new Map(), frame: 0, top: [], drag: null };
const petSpots = JSON.parse(localStorage.getItem('p9-pet-spots') || '{}'); // 'chats:<id>' or 'mdlBody:<id>' -> { box: [x, y] }, see petHome
// The 125 ms tick runs only while something on screen moves: a top-bar pet or spinner, a chat's spinner or a chat's pet. With
// no pet installed and no agent working it stops (review 2026-11-03: it ran forever, three sweeps and two rects per pane, eight
// times a second). Every path that puts a pet or spinner on screen ends in tickPets, which starts it again.
let petTimer = 0;
lifetime.signal.addEventListener('abort', () => { window.clearInterval(petTimer); petTimer = 0; });
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
let lastCards = '';
window.p9?.onCardAct?.(({ key, action }) => cardAct(cardList().find(c => c.key === key), action));

/* ---------- modals ---------- */
// One resizable dialog for every item. Its content is rebuilt from S on each open, so closing loses
// nothing: drafts live on the session or item, S.resume remembers the card view, and list scroll is kept.
// Closing puts the caret back in the field you were typing in before the card took you away.
const mdl = $('#mdl');
let lastEdit = null;
addEventListener('focusout', e => { const t = e.target; if (t.matches?.('textarea, input[type=text]') && !t.closest('dialog')) lastEdit = { pane: t.closest('.pane')?.dataset.id, id: t.id, sel: [t.selectionStart, t.selectionEnd] }; });
addEventListener('focusin', e => { if (!e.target.closest('dialog, .cards, .toasts, .lpanel') && !e.target.matches('textarea, input[type=text]')) lastEdit = null; });
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
  const row = listRow;
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
    body.innerHTML = `<div class="review"><span class="kind"><span class="lvl" data-l="${esc(a.level)}"></span> ${esc(a.kind)}</span><p>${esc(a.txt)}</p>${a.steps ? '<ol class="steps">' + a.steps.map(s => '<li><code>' + esc(s) + '</code></li>').join('') + '</ol><p>' + esc(a.after) + '</p>' : ''}${a.start ? '<p class="start"><b>Where to start:</b> ' + esc(a.start) + '</p>' : ''}<p class="muted sm">${a.steps || m.done ? '' : 'In the real app this opens the check\'s log in Mission Control.'}</p></div>`;
    $('#mdlFoot').innerHTML = `<span class="spacer"></span><button data-slot="button" data-variant="outline" data-dismiss>Dismiss</button>`;
    $('#mdlFoot [data-dismiss]').onclick = () => { S.alerts = S.alerts.filter(x => x !== a); renderCards(); missionLive(); m.back ? openModal(m.back) : closeModal(); };
  } else missionModal(m, body, row);
  body.scrollTop = top;
}
observe(() => { if (mdl.open && mdl.dataset.group) try { localStorage.setItem('eh-modal:' + mdl.dataset.group, JSON.stringify([mdl.offsetWidth, mdl.offsetHeight])); } catch {} }).observe(mdl);
$('#mdlX').onclick = closeModal;
$('#mdlBack').onclick = () => openModal(S.modal.back);
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

// D7: a modal sits in the top layer over any z-index and makes the page outside it inert, so the toast list (a popover) lives
// in the topmost open modal, or the page when none is open, and is put back on top after each toast and each modal opened or
// closed anywhere (Settings, the connecting screen, a confirm): above it and clickable.
if (sampleView) window.__toast = toast; // ponytail: the UI test's door, as window.__side
const showModal = HTMLDialogElement.prototype.showModal, modals = []; // in the order opened: the top layer's, not the page's
HTMLDialogElement.prototype.showModal = function () { showModal.call(this); modals.splice(modals.indexOf(this) >>> 0, 1); modals.push(this); raiseToasts(); };
document.addEventListener('close', e => { if (e.target instanceof HTMLDialogElement) raiseToasts(); }, true);
// Tabs (Builder, 2026-10-17: 30 sessions opened on every load): a live chat gets a tab while it is not stopped; the rest
// wait in History. The x stops it on the daemon, so every window and the phone agree (owner, 2026-10-25: a new window
// reopened 9 chats closed in another). Before that, closed IDs lived in this window's localStorage: loadChat stops the
// idle ones among them once, then forgets the list.
const closedChats = new Set(JSON.parse(localStorage.getItem('eh-closed-chats') || '[]'));
// Hide steps (Builder, 2026-10-18: "where is the button to hide the commands and thinking output?"): one switch for every chat, kept across restarts.
let hideSteps = localStorage.getItem('p9-hide-steps') === '1';
$('#newPop').innerHTML = `<div class="hd eyebrow" id="newInHd" hidden></div><div class="hd eyebrow" id="newFolderHd">Start in</div><select data-slot="select" aria-label="Start in" id="newFolder" style="margin:0 9px 6px;width:calc(100% - 18px)"></select><div id="newAgents"><div data-sec="claude"></div><div data-sec="codex"></div></div>`;
// New chat's folder (Builder, 2026-10-19: "a dropdown with what folder i want to open the chat in"; threat model row 24): the workspace,
// the main project, the last 5 folders used, or the system folder dialog (main sends back only a folder inside the workspace;
// ':pick' cannot be a folder, the daemon refuses ':' in paths).
// The daemon checks it again. The choice stays picked until changed.
let newFolder = '';
$('#newFolder').onchange = async e => {
  if (e.target.value !== ':pick') { newFolder = e.target.value; return; }
  let picked = await window.p9.pickFolder();
  if (picked?.remote) picked = await pickRemoteFolder();
  if (typeof picked === 'string') newFolder = picked;
  else if (picked === null) toast({ kind: 'chat', txt: 'Pick a folder inside the workspace.', level: 'warn' }, true);
  renderNewFolder();
};
// O29 (Builder, 2026-11-08): New chat opens on the agent used last on this computer (a chat made or a message sent): its
// section comes first and its first row has the focus, so + then Enter starts it, with that agent's saved defaults.
// O44: each row starts the model it names. A live P9's rows come from the agent's own list (the last one this window saw),
// after the row that starts on the defaults; before any list, that row alone. The sample data keeps its fixed names.
const SAMPLE_MODELS = { claude: ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'], codex: ['gpt-5.1-codex', 'gpt-5.1-codex-mini'] };
const row = (a, label, model) => `<button class="item" data-new="${a}"${model ? ` data-model="${esc(model)}"` : ''}>${label}</button>`;
const newRows = () => { for (const a of Object.keys(names)) $(`#newAgents [data-sec="${a}"]`).innerHTML = `<hr data-slot="separator" style="margin:6px 0"><div class="hd eyebrow">New ${names[a]}</div>`
  + row(a, `${names[a]} <span class="muted">default model</span>`, !liveChat.on && SAMPLE_MODELS[a][0])
  + (liveChat.on ? lastModels[a]?.options || [] : SAMPLE_MODELS[a].slice(1).map(v => ({ value: v, name: v }))).map(o => row(a, `${names[a]} · ${esc(o.name)}`, o.value)).join(''); };
const newPop = popover($('#newBtn'), $('#newPop'), () => { newRows(); $('#newAgents').prepend($(`#newAgents [data-sec="${lastAgent()}"]`)); panel.newAt($('#newBtn')); renderNewFolder(); $('#newPop [data-new]').focus(); }); // N1: placed beside its button (panel.mjs)
$('#newAgents').onclick = e => { const b = e.target.closest('[data-new]'); if (b) { newSession(b.dataset.new, b.dataset.model, panel.panel.newIn); newPop.close(); } };
DUWOP.menu($('#themePop')); popover($('#themeBtn'), $('#themePop'));

/* ---------- chats ---------- */
// CP5: each code block in a reply gets a Copy button (wire copies the code beside it).
const mdOf = e => { if (e.mdFor !== e.text || e.mdV !== codeColoursVersion()) { e.md = copyCode(mdReply.parse(e.text)); e.mdFor = e.text; e.mdV = codeColoursVersion(); } return e.md; };
// CP3: a sent photo comes back from the daemon by hash, once; until then (or once pruned) its tile stays blank.
const chatImgs = new Map();
// Panes are rebuilt from S on every change (streaming replies re-render every 18 ms), so the
// state a person owns lives in S or is carried across: draft in s.draft, images in s.images,
// tool/thinking open state in the event, scroll + caret captured here. A pane at the bottom stays pinned to it.
const bottoms = observe(() => $('.stage').style.setProperty('--chat-bottom', Math.max(0, ...[...$('#chats').querySelectorAll(':scope > .pane > .bottom')].map(b => b.offsetHeight)) + 'px')); // Chat Focus full: the artifact ends above the text box
const wiredBars = new WeakSet(), view = {}; // 'container:session id' -> { top, pinned, selection }
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
$('#fileScope').innerHTML = Object.entries(fileScopes).map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
$('#fileScope').onchange = e => { files.scope = e.target.value; files.dirs = {}; try { localStorage.setItem('eh-file-scope', files.scope); } catch {} renderTree(); };
window.p9?.onXfer?.(p => { if (p.id !== xfer.id || !$('#xferDlg').open) return; const bar = $('#xferBar'); if (bar) { bar.max = p.total || 1; bar.value = p.sent; $('#xferNum').textContent = bytes(p.sent) + ' of ' + bytes(p.total); } });
$('#xferBtn').onclick = sendFiles;
// line numbers for wrapped text: each number, then one blank row per extra row its line wraps onto
// ponytail: re-measures the whole file on every keystroke; fine for mock files, the real IDE engine owns this
const mirror = document.createElement('div');
// D7: Ctrl+S saves the editor on screen wherever the focus is in its window: a Save click re-renders the modal and drops the
// focus to the page, which used to leave Ctrl+S doing nothing at all.
let edSave = null;
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's' || !edSave?.root.isConnected) return;
  const host = edSave.root.closest('dialog') || edSave.root, at = document.activeElement;
  if (!host.checkVisibility() || (at && at !== document.body && !host.contains(at))) return; // a closed modal never saves
  e.preventDefault(); edSave.save(); edSave.after();
});
// a _tyler item's file as read-only text: the question line and the empty A. line are already in the review
const fileView = name => doc(name).text.split('\n').filter(l => l.trim() && !/^# |^A\.|^<!--/.test(l)).map(l => `<p>${esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`).join('');

/* ---------- Mission Control ---------- */
// workspace-hub's sections from fixtures. Only change from the hub: script buttons are grouped into
// category tiles, each opening a modal (Builder 2026-10-14). Nothing runs; outputs are mock.
// one Catppuccin Mocha accent per word, stable, so a project or kind keeps its colour
const CTP = ['#cba6f7', '#89b4fa', '#94e2d5', '#fab387', '#f5c2e7', '#a6e3a1', '#89dceb', '#f9e2af', '#b4befe', '#eba0ac'];
// A top-row tile knows its level before its window is opened (a tile is a light that shows red while there is an
// issue): while Mission is on screen, each unplaced section's tiles and cards are asked every 30 s too. The tile is shown, so
// row 70 still holds; the daemon answers a second ask within 30 s of its last run from that run, so an open window shares it.
let topAt = 0;
setInterval(pullTopLevels, 30000);
// Live data from the daemon (window.p9.mission) fills the lists once it answers; until then the page says why it is empty.
const live = { on: false, note: window.p9?.mission ? 'Connecting to the P9 daemon…' : 'No P9 daemon in this view', primary: null, waiting: '' };
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadUsage().then(renderChats); });
let usageSoon = 0;
setInterval(() => { if (document.hidden) return; for (const s of S.sessions) for (const el of document.querySelectorAll('.pane[data-id="' + s.id + '"] .cache')) { const [text, state] = cacheOf(s); el.dataset.s = state; el.lastChild.textContent = text; } }, 15000);
// The tiles' pictures, site icons and program icons (the daemon fetches and caches; the renderer loads no remote image). Redraws only if they changed.
let lastArt = '';
// M3: a change to settings, the registry or the space shows within one poll. Only while Mission is in front and the window is
// showing; renderMission writes only what changed, so an idle poll costs one local request.
let lastOverview = '';
// _tyler/ items a chat makes get their card when its turn ends (Builder, 2026-10-17); otherwise the queue is read at start.
let queueTimer = 0;
// D4 / #14: the chip on a waiting item says who it waits on: the owner's own name from Settings, else "needs you".
const needsLabel = () => settings.name ? 'needs ' + settings.name : 'needs you';
// _tyler/ items newest first, or by project: the file name starts with it, <project>-<what>.md (Builder, 2026-10-19 #1).
function reviewSort() { const by = localStorage.getItem('eh-review-sort') === 'project' ? 'project' : 'updated';
  S.reviews.sort(by === 'project' ? (a, b) => (a.name || a.proj).localeCompare(b.name || b.proj) : (a, b) => (b.updated || 0) - (a.updated || 0)); return by; }
// Mission is short: script tiles, then one small card per section (title, a number, one line) that opens the
// section in the modal window (Builder, 2026-10-17: "hard to navigate because its so long ... group everything so
// that its in a window i can open"). Cards are shaped like workspace-hub's Waiting on you and Last solo run boxes.
const sample = () => (sampleView ? ' · sample' : '');
// card() gives [number or name, one line, level]; body() is the window's content (the three lists fill in missionLive)
const wins = {
  mprimary: { show: () => live.primary, title: () => 'Main project', card: () => [live.primary.name, live.primary.status.replace(/\*\*/g, ''), 'ok'],
    body: () => `<p><b>${esc(live.primary.name)}</b> <span class="muted sm mono">${esc(live.primary.path)}</span></p><p class="sm">${esc(live.primary.status.replace(/\*\*/g, ''))}</p>` },
  mnotes: { show: () => widgetOn('notifications'), title: () => 'Notifications' + sample(), card: () => { const n = allNotes(); return [n.length, n[0]?.txt || noticeLine(), n.some(a => a.level === 'bad') ? 'bad' : 'ok']; }, body: () => '' },
  mlaunch: { show: () => widgetOn('apps'), title: () => 'Apps and pages', card: () => [M.apps.length + M.pages.length, M.apps.concat(M.pages).map(x => x[0]).join(' · ') || 'None in the registry', 'ok'],
    // Each app or page is its own launch tile: P9's icon for P9, a lettered tile in its tint for the rest (Builder, 2026-10-18 #3:
    // "APPs and pages can have the graphic or icon as the button to launch it"). ponytail: the registry has no icon field yet.
    body: () => !M.apps.length && !M.pages.length ? '<p class="empty" data-launch-empty>No apps or pages added yet.</p>' : `<div class="launch">${M.apps.map((a, i) => launchTile(a[0], a[1], `data-app="${i}"`, a[3], false, a[4], art('apps', a[3]))).join('')}${M.pages.map((p, i) => launchTile(p[0], p[1], `data-page="${i}"`, '', true, p[3], art('pages', p[2]))).join('')}</div>` },
  musage: { show: () => widgetOn('usage'), title: () => 'Usage', card: () => { const c = usage.limits && limitLine('Claude', usage.limits.claude); return [c ? c.text.split(' · ')[0].replace(/ \(.*/, '') : usage.totals.outputTokens.toLocaleString(), c ? 'Claude · ' + c.text : 'output tokens recorded', c?.stale ? 'warn' : 'ok']; }, body: usageBody,
    // On the page: each agent's plan windows as rows with the pace tick
    inline: () => { const rows = usageRows();
      return (rows ||'<p class="empty">No plan limits recorded yet.</p>') + (usage.state === 'unavailable' ? '' : `<p class="sm muted">${usage.totals.outputTokens.toLocaleString()} output tokens · $${usage.totals.costUsd.toFixed(2)} recorded</p>`); } },
};
// M4 (threat model row 72): the shipped guide and template list, fetched once the first time Mission is empty.
let guide = null;
// Finding 4: the space Mission shows, in the top bar in Mission focus: Main, every scratch space, and + Add. Opening it reads the
// space list again, so a space made on the phone or through the MCP tools shows at once, not at the next 20 s poll. Switching sets
// settings.space_name through the space route and writes no space file; only Delete, after its confirm, removes one.
let spacePop = null, spaceForm = null; // spaceForm: the Delete confirm or the Save as template form, kept through polls
let spaceMenuHtml = '';
function renderMission() {
  renderSpaceBtn();
  // A fresh profile shows only the onboarding card (M4): no panels, nothing else to read yet. + Add shows it too (finding 4);
  // a template click shows its preview.
  if ((live.empty || live.adding) && !sampleView) {
    const t = live.preview && guide?.templates?.find(x => x.name === live.preview);
    setHTML($('#fMission'), t ? previewCard(t, esc) : onboardCard({ templates: guide?.templates, protect: live.fileProtection }, esc)
      + (live.adding ? `<p class="onboard-back"><button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-add-cancel>Back to ${esc(live.spaceName || 'Main')}</button></p>` : ''));
    bindOnboard($('#fMission'));
    if (!guide) loadGuide();
    return;
  }
  pullTopLevels();
  const lay = placed();
  // Three parts written apart, so a top-row change (a tile's count or level) leaves the columns and their card frames in place;
  // one write of the whole page made every card again, which showed as cards flashing and losing their place.
  setHTML($('#fMission'), '<div class="mpart"></div><div class="mpart"></div><div class="mpart"></div>');
  const [mTop, mNotes, mBody] = $('#fMission').children;
  setHTML(mTop, `<div class="tiles" aria-label="Script categories">${topRow(lay)}</div>`);
  setHTML(mNotes, ''
    + (live.note ? `<p class="muted sm" data-mission-note>${esc(live.note)}${live.noteRestart ? restartBtn() : ''}</p>` : '')
    + (missionEmpty() ? missionIntro() : '')
    + (live.settingsError ? `<p class="sm" data-settings-error role="status">settings.json was changed but P9 cannot use it (${esc(live.settingsError)}). It keeps using the earlier settings until the file is fixed.</p>` : '')
    + (live.restart?.needed ? `<p class="sm" data-restart role="status"><b>Restart P9 to apply.</b> The workspace folder ${esc(live.restart.folder)} was not there when P9 started, so it is using the default folder.${restartBtn()}</p>` : ''));
  setHTML(mBody, ''
    // Waiting on you as a list on the page that scrolls on its own, with the big count workspace-hub had (Builder, 2026-10-18 #3). Three columns fill the window; each list scrolls inside itself.
    + (lay ? '<div class="mrow" data-placed>' + placedCols().map(c => `<div class="mcol" data-col="${c.n}"${c.w ? ` data-w="${c.w}"` : ''}>${c.mine.map(placedHtml).join('')}</div>`).join('') + '</div>'
      : '<div class="mrow">' + (widgetOn('waiting') ? NEEDS : '')
    + '<div class="mcol">' + byFile([['primary', '<div data-card="mprimary"></div>'], ['usage', winPanel('musage')]]) + '</div>'
    + '<div class="mcol">' + byFile([['apps', winPanel('mlaunch')], ['notifications', '<div class="wins" aria-label="Mission sections"></div>']]) + '</div></div>'));
  $('#fMission').querySelectorAll('[data-group]').forEach(b => b.onclick = () => openModal({ kind: 'scripts', g: b.dataset.key ?? b.dataset.group }));
  $('#fMission').querySelectorAll('[data-wtile]').forEach(b => b.onclick = () => openModal(b.dataset.wtile === 'waiting' ? { kind: 'reviews' } : { kind: 'win', id: b.dataset.wtile }));
  $('#fMission').querySelectorAll('[data-restart-btn]').forEach(b => b.onclick = () => restartP9(b));
  $('#fMission').querySelectorAll('[data-mission-docs]').forEach(b => b.onclick = () => window.p9.openDocs('buttons-apps-and-pages').catch(() => {}));
  const sort = $('#fMission [data-sort]'); // only where Waiting on you is drawn (finding 3a)
  if (sort) { sort.value = reviewSort(); sort.onchange = () => { try { localStorage.setItem('eh-review-sort', sort.value); } catch {} reviewSort(); missionLive(); }; }
  // New idea on the page itself, where workspace-hub had it (Builder, 2026-10-18: it was hidden in the Workspace window).
  $('#fMission').querySelectorAll('[data-idea]').forEach(b => b.onclick = () => openModal({ kind: 'idea', name: '', text: '', needs: false }));
  $('#fMission').querySelectorAll('[data-medit]').forEach(b => b.onclick = () => openModal({ kind: 'medit', items: editItems(M) }));
  $('#fMission').querySelectorAll('[data-sprint]').forEach(b => b.onclick = () => openModal({ kind: 'sprint', sec: b.dataset.sprint || undefined }));
  missionLive();
  if (mdl.open && S.modal?.kind === 'win') renderModal();
}
// One note: the rendered preview, or the editor; Save sends the hash it was read with, so a change on disk is never overwritten.
function noteModal(m, body) {
  const key = noteKey(m.root, m.path);
  $('#mdlT').textContent = m.path;
  // a draft kept from an earlier open keeps the hash it was read with; otherwise read the disk again
  if (!m.asked && !dirty(key)) {
    m.asked = true;
    window.p9.mission('noteRead', { root: m.root, path: m.path }).then(r => {
      if (r.status === 200) m.readOnly = !!r.body.readOnly; // review 3 L2: _private with File protection on
      if (m.readOnly) m.edit = false;
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

/* ---------- chat tools (each pane's header: files, split, search, terminal; the terminal also on the panel's foot) ---------- */
const pressed = (k, v) => document.querySelectorAll(`[data-tool=${k}]`).forEach(b => b.setAttribute('aria-pressed', String(v)));
const toggleFiles = () => { S.files = !S.files; $('#files').hidden = !S.files; pressed('files', S.files); if (S.files && live.on) { files.dirs = {}; renderTree(); } };
const toggleSplit = () => { S.split = !S.split; if (S.split && S.open.length < 2) { const s = S.sessions.findLast(x => !x.hidden && !S.open.includes(x.id)); if (s) S.open.push(s.id); } pressed('split', S.split); renderTabs(); renderChats(); };
const TOOLS = { files: toggleFiles, split: toggleSplit, term: () => toggleTerm(), search: () => { if (!S.files) toggleFiles(); $('#fileSearch').focus(); } };
addEventListener('click', e => { const b = e.target.closest?.('[data-tool]'); if (b && TOOLS[b.dataset.tool]) TOOLS[b.dataset.tool](); });
// One shared shell; each focus remembers whether it shows it and how (Builder 2026-10-14):
// Dev opens it as a drawer, Chat and Mission as a pop-out. dFloat flips the mode for that focus.
// Dev Focus docks it only: the editor is a separate view drawn above this page, so a floating terminal went behind it.
function showTerm() {
  const f = S.focus, open = S.termOpen[f], float = f !== 'dev' && S.termMode[f] === 'float';
  if (dock.classList.contains('float') && !float) dock.style.height = dock.style.width = dock.style.left = dock.style.top = dock.style.translate = '';
  dock.hidden = !open; dock.classList.toggle('float', float);
  $('#dFloat').hidden = f === 'dev';
  pressed('term', open);
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
// U8: the slim Temporary P9 on a remote has no Mission Control (Always on installs the full P9, which has it).
const focusOn = f => !!settings.focus[f] && !(f === 'mission' && serverInfo?.slim);
function setFocus(f, stay = false) {
  if (!focusOn(f)) return; // turned off in Settings, or not on this remote
  S.focus = f;
  if (f === 'mission') { refreshMission(); if ($('#fMission .mrow[data-placed]')) missionLive(); }
  if (!stay) { try { localStorage.setItem('p9-last-focus', f); } catch {} leaveLanding(); }
  document.querySelectorAll('.fpane').forEach(p => { const on = p.dataset.focus === f; p.classList.toggle('on', on); p.inert = !on; });
  document.querySelector('.shell').dataset.focus = f;
  document.querySelectorAll('[data-focus-btn]').forEach(b => b.setAttribute('aria-pressed', b.dataset.focusBtn === f));
  panel.renderPanel(); // full in Chat Focus, the strip elsewhere
  renderIndicator(); // each focus has its own pets
  $('#focusTitle').textContent = focusNames[f];
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
  const visible = S.focus === 'dev' && r.width > 0 && r.height > 0 && !document.querySelector('dialog[open]') && now?.mode !== 'full' && !devFrozen;
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
  if (visible) devRect = { x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(0, right - x)), height: Math.round(Math.max(0, bottom - y)) };
  return window.p9.devView(visible ? { visible, ...devRect } : { visible });
}
// Builder, 2026-11-02 ("the editor being on top of everything"): a top-bar menu (machines, theme, history) opened over the view
// would be under it. While one is open over it, a still of the editor (p9:dev-still) takes its place and the view steps aside;
// closing the menu brings the live editor back. The still costs one capture per menu opened, only when the menu is over the editor.
let devRect = null, devFrozen = false, devFreezing = 0;
const devStill = Object.assign(document.createElement('img'), { hidden: true, alt: '' });
devStill.style.cssText = 'position:fixed;pointer-events:none';
$('#fDev').append(devStill);
const menuOverDev = () => S.focus === 'dev' && devRect && [...document.querySelectorAll('.pop:not([hidden])')].some(p => {
  const a = p.getBoundingClientRect();
  return a.right > devRect.x && a.left < devRect.x + devRect.width && a.bottom > devRect.y && a.top < devRect.y + devRect.height;
});
async function devFreeze() {
  const want = Boolean(window.p9?.devStill) && menuOverDev();
  if (want === devFrozen) return;
  const mine = ++devFreezing;
  if (want) {
    const src = await window.p9.devStill().catch(() => null);
    if (mine !== devFreezing) return;
    if (src) { devStill.src = src; Object.assign(devStill.style, { left: devRect.x + 'px', top: devRect.y + 'px', width: devRect.width + 'px', height: devRect.height + 'px' }); devStill.hidden = false; }
    devFrozen = true; placeDev();
    return;
  }
  devFrozen = false;
  await placeDev()?.catch(() => {});
  // ponytail: one frame's grace for the view to paint before the still goes; a slow GPU could still show one frame of the pane.
  requestAnimationFrame(() => { if (mine === devFreezing) devStill.hidden = true; });
}
// A menu whose rows arrive after it opens (the machine list) only reaches down over the editor once it grows, so its size counts too.
const popSize = new ResizeObserver(devFreeze);
document.querySelectorAll('.pop').forEach(p => { new MutationObserver(devFreeze).observe(p, { attributeFilter: ['hidden'] }); popSize.observe(p); });
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
if (window.p9?.terminalOpen) import('./terminal.mjs').then(({ createTerminal, TMUX_MISSING_HERE, unavailableText: text }) => {
  if (lifetime.signal.aborted) return;
  tmuxMissing = TMUX_MISSING_HERE; unavailableText = text;
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
const cmds = [['Notification Center', () => openModal({ kind: 'center' })], ['Usage', () => openUsage()], ['Walkthrough', () => walkthrough()],['Simulate an agent question', () => askNow()], ['Simulate a system notification', () => toast({ kind: 'silent job', txt: 'nightly-backup did not report in', level: 'bad' })], ['Chat Focus', () => setFocus('chat')], ['Dev Focus', () => setFocus('dev')], ['Mission Control', () => setFocus('mission')], ['New Codex session', () => newSession('codex', liveChat.on ? '' : 'gpt-5.1-codex')], ['New Claude session', () => newSession('claude', liveChat.on ? '' : 'Opus 5.5')], ['Toggle chat split', toggleSplit], ['Browse files', TOOLS.search], ['Toggle files pane', toggleFiles], ['Toggle terminal', toggleTerm], ['Stop all sessions', () => $('#stopAll').click()], ['Look: Event Horizon', () => DUWOP.set('event-horizon')], ['Look: Redline', () => DUWOP.set('redline')], ['Look: Night Drive', () => DUWOP.set('night-drive')], ['Look: Duskwood', () => DUWOP.set('duskwood')], ...MAINTENANCE.filter(m => m.when()).map(m => [m.label, maintain[m.id]])];
let palSel = 0;
// U8: no Mission commands on a slim Temporary remote, which has no Mission Control, or while Mission is off in Settings.
const MISSION_CMDS = new Set(['Mission Control', 'Refresh Mission']);
// N1 point 5: Ctrl K also jumps to a chat or a project (panel.jumps: [label, run, icon, hint]); run() indexes this list.
let palRows = [];
function renderPal() { const q = $('#palIn').value.toLowerCase(); palRows = [...cmds.filter(c => c[0].toLowerCase().includes(q) && ((!serverInfo?.slim && settings.focus.mission !== false) || !MISSION_CMDS.has(c[0]))), ...panel.jumps(q)]; palSel = Math.min(palSel, Math.max(0, palRows.length - 1)); $('#palList').innerHTML = palRows.map((c, i) => `<li role="option" aria-selected="${i === palSel}" data-i="${i}">${c[2] || svg.bolt.replace('<svg', '<svg width="14" height="14"')}${esc(c[0])}${c[3] ? `<small>${esc(c[3])}</small>` : ''}${i === palSel ? '<kbd>↵</kbd>' : ''}</li>`).join('') || '<li class="muted">Nothing matches</li>'; $('#palList').querySelectorAll('li[data-i]').forEach(li => li.onclick = () => run(+li.dataset.i)); }
function run(i) { $('#palette').close(); palRows[i][1](); }
function openPal() { $('#palIn').value = ''; palSel = 0; renderPal(); $('#palette').showModal(); $('#palIn').focus(); }
$('#rCmd').onclick = openPal;
// The panel's Usage button (A3): the Usage window from any focus, with a fresh read.
const openUsage = () => { openModal({ kind: 'win', id: 'musage', any: true }); loadUsage(); };
$('#rUsage').onclick = openUsage;
$('#palIn').oninput = () => { palSel = 0; renderPal(); };
$('#palIn').onkeydown = e => { const n = $('#palList').querySelectorAll('li[data-i]').length; if (e.key === 'ArrowDown') { palSel = (palSel + 1) % n; renderPal(); } if (e.key === 'ArrowUp') { palSel = (palSel - 1 + n) % n; renderPal(); } if (e.key === 'Enter') { e.preventDefault(); const li = $('#palList').querySelector('li[aria-selected="true"]'); if (li) run(+li.dataset.i); } };
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#palette').open ? $('#palette').close() : openPal(); } });

/* ---------- settings (phase 18) ---------- */
// The desktop keeps them in its profile folder (main.mjs checks the shape); a browser preview keeps them in localStorage.
// The agent lock is the daemon's (threat model row 15): this page only shows and asks to change it.
let settings = { name: '', startLast: false, zoom: 1, closeOnSend: false, xfer: { fileMiB: 512, files: 20000, sendGiB: 4 },focus: { chat: true, dev: true, mission: true }, pet: { chat: { ...DEFAULT_PET }, dev: { ...DEFAULT_PET, on: false }, mission: { ...DEFAULT_PET, on: false } } }, agentLock = null, fileProtect = null, termGreeting = null, serverInfo = null, pets = null, petMode = null, updates = null, updatesTimer = 0;
// ST1/ST2: Settings → Mission Control files, the daemon's settings.json (not this window's settings), so the paths stay
// editable after setup. The wizard's path rows (PATH_KEYS) plus the other keys; each row saves on change through the daemon,
// which checks it as it checks the file at start. A refused value stays in its box with the reason under it.
let missionFiles = null;
let setPage = 'General';
$('#setBtn').onclick = async () => {
  if (window.p9?.listPets) pets = await window.p9.listPets().catch(() => null);
  if (window.p9?.chat) { const r = await liveChat.call('lock'); agentLock = r.status === 200 ? r.body.on : null; }
  if (window.p9?.fileProtection) { const r = await window.p9.fileProtection().catch(() => null); fileProtect = r?.status === 200 ? r.body.on : null; }
  if (window.p9?.terminal) { const r = await window.p9.terminal('greeting', {}).catch(() => null); termGreeting = r?.status === 200 ? r.body.show : null; }
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
// The one rollback switch (landing v5, approved 2026-10-29): 'video' plays the rendered loop over its poster; 'original'
// brings back the WebGL sky below. P9_LANDING=original sets it for a run; the default is the video. Send-to-server keeps
// its own createSky (#moveSky) either way. The phone has its own page and never loads this.
const LAND_BG = window.p9?.landingBg === 'original' ? 'original' : 'video';
let landVideo = null;
if (LAND_BG === 'video') {
  const cosmos = land.querySelector('.p9-cosmos');
  cosmos.querySelector('img').src = landPoster;
  Object.assign(cosmos.querySelector('video'), { poster: landPoster, src: landLoop });
  cosmos.hidden = false; $('#landSky').hidden = true;
  // The video is the whole landing: no P9 mark over the hole (Builder, 2026-10-29: "A. remove it", kept 2026-10-31).
  land.querySelector('.land-mark').remove();
  // Plays only while the landing is open (its dialog is shown) and the window is not hidden; reduced motion, a blocked
  // play or a failed load leave the poster (playback.mjs).
  landVideo = mountLandingVideo(cosmos);
}
const sky = LAND_BG === 'video' ? NO_SKY : createSky($('#landSky')), SKY_MAIN = { uDist: 34, uShift: 0.2, uIgnite: 1, uStars: 1, uDim: 0.62 };
const LAND = { started: false, raf: 0, v: { ...SKY_MAIN }, from: null, to: null, t0: 0, ms: 0, drawn: 0, spin: 0 };
if (!landOn) land.removeAttribute('data-pending');
land.addEventListener('close', () => {
  try { sessionStorage.setItem('p9-landed', '1'); } catch {}
  landVideo?.refresh();
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
  if (f && focusOn(f)) { e.preventDefault(); setFocus(f); }
});
land.querySelectorAll('[data-land]').forEach(b => {
  b.querySelector('.ic').innerHTML = svg[{ chat: 'chat', dev: 'code', mission: 'gauge' }[b.dataset.land]];
  b.onclick = () => setFocus(b.dataset.land);
});
$('#landSet').innerHTML = svg.gear;
$('#landSet').onclick = () => $('#setBtn').click();
$('#brandBtn').onclick = () => openLanding(false);

/* ---------- first-run setup wizard (v0.1.3 C1; threat model rows 17, 31, 32) ---------- */
// Seven screens (Builder approved them, 2026-10-22). It opens itself once, after the landing intro and before the walkthrough.
// Skip, or the Set up card's x, moves the card into the Notification Center until all four checks pass ("4 auto and if its
// skipped, add it to notifications that goes away when its completed"). Nothing is stored but the skip: an open re-reads
// /setup and the sign-in state every 2 s and starts at the first step not done. A failure shows its cause, one fix and Retry.
// The last status's mode: the wizard's in-app admin password is for this computer only (row 61).
let setupMode = '';
function wizRender() {
  const s = W.s, steps = wizSteps(), key = steps[Math.min(W.i, steps.length - 1)], d = s ? setupDone(s) : {};
  W.i = steps.indexOf(key);
  const yes = (ok, good, bad) => `<span class="${ok ? 'ok' : 'warn'}">${ok ? '✓ ' + good : bad}</span>`;
  const btn = (act, label, variant = 'outline') => `<button data-slot="button" data-variant="${variant}" data-act="${act}"${W.busy ? ' disabled' : ''}>${label}</button>`;
  const PW_ERR = ['wrong-password', 'password-empty']; // fixed by Install again, not Retry
  const fail = (error, detail = '') => { const [cause, fix] = WIZ_ERR[error] || ['That did not work (' + error + ').', 'Retry.']; return `<div class="wiz-fail" role="alert"><strong>${esc(cause)}</strong>${detail ? `<span class="mono sm">${esc(detail)}</span>` : ''}<span class="muted sm">${esc(fix)}</span>${PW_ERR.includes(error) ? '' : btn('retry', 'Retry')}</div>`; };
  const row = (name, note, status, actions = '') => `<div class="set-row"><span><strong>${name}</strong>${note ? `<span class="muted sm">${note}</span>` : ''}</span><span class="spacer"></span>${status}${actions}</div>`;
  const note = W.note[key];
  let title, body, next = btn('next', 'Next', 'default');
  if (!s && key !== 'welcome') { title = 'Setup'; body = fail('daemon-unavailable'); }
  else if (key === 'welcome') {
    title = 'Welcome to Event Horizon'; next = btn('next', window.p9?.server ? 'Set up this computer' : 'Start', 'default');
    // D1: P9 can also be this window onto a P9 that runs on another machine (Server mode, Settings > Server).
    body = `<p>A few checks make P9 yours: a workspace folder it can write to${s?.tmux === null ? ' and' : ','} an agent you are signed in to${s?.tmux === null ? '' : ' and the terminal'}. About five minutes.</p><p class="muted sm">Skip any time. The Set up card then waits in the Notification Center until every check passes.</p>`
      + (window.p9?.server ? row('Work on a remote over ssh?', 'This window can use P9 on another machine. Once connected, you choose how P9 runs there: kept running, so your phone and this desktop reach it any time, or only while you are connected. A remote with no P9 yet gets it installed when you say so.', '', btn('remote', W.remote ? 'Hide' : 'Connect to a remote')) : '')
      + (W.remote ? wizRemote(btn) : '');
  } else if (key === 'workspace') {
    title = 'Your workspace';
    body = row('Folder', `<span class="mono" id="welWs">${esc(s.workspace)}</span>`, yes(s.writable, 'P9 can write here', 'P9 cannot write here'))
      + `<p class="muted sm">This is your main working folder while you use P9. You can change it any time in Settings. If you have no workspace or project folder you prefer, P9 makes one for you. Changing it restarts P9's background service: running chats, scripts and terminals stop.</p>`
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
          + (l.unsupported && !l.running ? '<p class="warn sm">This Codex has no sign-in with a code (P9 was built with Codex 0.166.0, which has one). Use Sign in in a terminal below and follow what Codex prints there.</p>'
            : ended ? `<p class="warn sm">${name} sign-in ended without signing in. Retry starts it again; finish in the browser before closing it.</p>` : '')
          // D8: its own sign-in command in a P9 terminal, run by the CLI P9 ships (item 15). Nothing runs before Enter.
          + (s[a + 'Cli'] && !on && !l.running ? `<div class="set-row"><span class="muted sm">Or sign in with ${name}'s own command in a P9 terminal.</span><span class="spacer"></span>${btn('term:' + a + ':login', 'Sign in in a terminal')}</div>` : '')
          + (W.note[a]?.error ? fail(W.note[a].error, W.note[a].detail) : '');
      }).join('');
    if (!d.agents) next = '<span class="muted sm">Sign in to one to go on, or Skip.</span>' + btn('next', 'Next', 'default').replace('<button', '<button disabled');
  } else if (key === 'mission') {
    title = 'Mission Control'; next = settings.focus.mission ? btn('mission-open', 'Open Mission Control', 'default') : '';
    // Fresh-install findings 1 and 2: Mission starts empty and is built there; the daemon writes its own empty settings file
    // (a finished step, unless the workspace already has a registry or a waiting folder: then this step opens with them filled in), from its onboarding card (with an agent or a
    // template). Files from an older setup sit under "I already have Mission files", every path optional. A folder with
    // things in it keeps them (needs-done p9-wizard-respects-existing-workspace): Use these files writes only settings.json,
    // plus any path typed here that is not there yet, listed first.
    const choosing = wizChoosing(s), paths = wizPaths(), open = W.have ?? Boolean(s.found?.registry || s.found?.waiting || (s.conflict && (s.agentsFile !== null || s.registryFile !== null)));
    body = '<p data-mission-empty>Last, build Mission Control: your control room for scripts, live numbers, logs, notes and links. It starts empty. Open Mission Control takes you to its own wizard, where an agent builds it with you or you start from a template.</p>'
      + (s.settings && !(s.agentsFile === null && s.registryFile === null) ? `<p class="muted sm">Mission already uses your settings file, <span class="mono" id="welFile">${esc(s.settingsFile || '')}</span>.</p>` : '')
      + (choosing ? `<details class="wiz-have" data-have${open ? ' open' : ''}><summary>I already have Mission files</summary>`
        + `<div class="set-row"><span class="muted sm">Point P9 at the files you already have. Every path is optional: leave out any you do not use.</span>${btn('docs', 'How these files work')}</div>`
        + '<div class="wiz-paths">' + PATH_KEYS.map(([k, name, kind]) =>`<label class="set-row"><span><strong>${esc(name)}</strong></span><span class="spacer"></span><input data-slot="input" class="mono" data-path="${k}" value="${esc(paths[k] || '')}" maxlength="400" autocomplete="off" spellcheck="false">${window.p9.pickFolder && kind ? btn('pick:' + k + ':' + kind, 'Pick') : ''}</label>`).join('') + '</div>'
        + (s.pathsInvalid ? fail('paths-invalid') : '')
        + (s.conflict ? `<p class="sm" data-conflict>This folder has its own files (${Object.values(s.found).map(esc).join(', ')}) that your settings file does not name. The paths above are what P9 found; change any, then press Use these files. Your old settings file is kept as settings.json.bak.</p>` : '')
        + (W.paths && s.creates?.length ? `<p class="sm">These are not there yet, and Use these files makes them empty: <span class="mono" data-creates>${s.creates.map(esc).join(', ')}</span></p>` : '')
        + (Object.keys(paths).length && !s.pathsInvalid ? `<div class="set-row">${btn('starter', 'Use these files')}<span class="muted sm">Saves these paths in your settings file.</span></div>` : '')
        + '</details>' : '')
      + (s.settingsInvalid ? fail('settings-invalid', s.settingsError) : '')
      + (note?.created ? `<p class="ok sm">Saved.${note.created.length ? ' Created: ' + note.created.map(esc).join(', ') : ''}</p>` : '')
      + (note?.error ? fail(note.error, note.detail) : '')
      + (settings.focus.mission && (settings.focus.chat || settings.focus.dev) ? `<div class="set-row">${btn('mission-off', 'Turn Mission off for now')}</div>` : '');
  } else if (key === 'terminal') {
    // Item 15 (threat model row 61): what P9 cannot carry. The reason comes first, then why it needs the admin password,
    // then the command. In the desktop app on its own computer, the admin password field and Install run it (desktop main,
    // p9:admin-install); elsewhere Run in a terminal types it into a P9 terminal and sudo asks there (tmux: Copy, since P9's terminals are tmux).
    const admin = (s.dependencies || []).filter(x => x.admin), here = !!window.p9?.adminInstall && setupMode !== 'server',
      there = !!window.p9?.remoteDeps && !!adminAsk && setupMode === 'server', fixable = admin.some(x => ['tmux', 'ssh'].includes(x.id));
    title = admin.length ? 'This needs your admin password' : 'Terminal';
    body = admin.length ? admin.map(x => `<div class="wiz-admin" data-admin="${esc(x.id)}">${row(ADMIN_NAMES[x.id] || esc(x.id), esc(x.why), yes(false, '', 'Not installed'))}`
        + `<p class="sm" data-admin-why>Everything else P9 needs comes with it or goes into your own folders. This one goes into the system itself, and only an admin can change that, so ${there ? 'the remote asks for your admin password there' : 'your computer asks for your password'}.</p>`
        + (x.command && here && ['tmux', 'ssh'].includes(x.id) ? `<div class="set-row"><code class="mono" data-command>${esc(x.command)}</code></div>`
          + `<label class="sm wiz-pw-label" for="wizPw-${esc(x.id)}">Admin password for your account on this computer</label>`
          + `<div class="set-row"><input data-slot="input" type="password" id="wizPw-${esc(x.id)}" data-admin-pw="${esc(x.id)}" autocomplete="off" spellcheck="false" maxlength="1024">${btn('pw:' + x.id, 'Install', 'default')}</div>`
          + '<p class="muted sm">P9 runs the command above as admin with it. It goes once to sudo on this computer; never saved, never shown in any log.</p>'
        : there && ['tmux', 'ssh'].includes(x.id) ? '' : x.command ? `<div class="set-row"><code class="mono" data-command>${esc(x.command)}</code><span class="spacer"></span>`
          + (x.id === 'tmux' ? btn('copy:' + x.id, 'Copy') + '</div><p class="muted sm">P9\'s terminals need tmux, so run it in your own terminal app, then Retry.</p>'
            : btn('admin:' + x.id, 'Run in a terminal') + '</div><p class="muted sm">Types it into a P9 terminal. Read it, press Enter, then type your password there.</p>')
          : '<p class="muted sm">Install it with your system\'s package manager, then Retry.</p>')
        + (W.note[x.id]?.error ? fail(W.note[x.id].error, W.note[x.id].detail) : '') + '</div>').join('')
        // Row 61 on a remote: one button for all of it; the remote computes the command and the admin window shows it.
        + (there && fixable ? `<div class="set-row">${btn('rdeps', 'Install with admin password', 'default')}</div>`
          + '<p class="muted sm">P9 asks for your admin password on this remote and shows the command it runs there. Never saved, never shown in any log.</p>'
          + (W.note.rdeps?.error ? fail(W.note.rdeps.error) : '') : '')
        + `<div class="set-row">${btn('retry', 'Retry')}</div>`
      : row('tmux', 'The terminal dock runs real shells in tmux.', yes(s.tmux, 'Found', 'Not found')) + (s.tmux ? '' : fail('tmux-not-found'));
  } else if (key === 'you') {
    title = 'You';
    body = `<label class="set-row"><span><strong>Your name</strong><span class="muted sm">The landing page greets you with it. Empty: no name.</span></span><span class="spacer"></span><input data-slot="input" id="welName" maxlength="40" autocomplete="off" spellcheck="false" value="${esc(W.name ?? settings.name ?? '')}"></label>`
      // Issue #4 item 4, option C (the owner, 2026-10-20): Skipper ships as the default; petdex.dev has more.
      + row('Pets', 'Skipper is your System pet. Find more at <a id="welPetdex" href="https://petdex.dev" target="_blank" rel="noopener">petdex.dev</a>, then add them in Settings → Pets.', '', btn('pets', 'Open Settings → Pets'));
  } else {
    title = Object.values(d).includes(false) ? 'Almost there' : 'You are set';
    body = Object.entries(STEP_NAMES).filter(([k]) => k !== 'mission' && (k !== 'terminal' || s.tmux !== null)).map(([k, name]) => row(name[0].toUpperCase() + name.slice(1), '', yes(d[k], 'Done', 'Not done yet'))).join('')
      + row('Tour', 'Each focus in about two minutes.', '', btn('tour', 'Take the tour'))
      + '<p class="muted sm">Settings → Setup opens this again.</p>';
  }
  $('#welT').textContent = title;
  $('#welStep').textContent = `Step ${W.i + 1} of ${steps.length}`;
  morph($('#welBody'), body);
  morph($('#welFoot'), (W.i ? btn('back', 'Back') : '') + '<span class="spacer"></span>' + (W.i === steps.length - 1 ? btn('close', 'Close') : btn('skip', 'Skip')) + next);
}
$('#welDlg').addEventListener('input', e => { if (e.target.id === 'welCode') W.code = e.target.value; if (e.target.id === 'welName') W.name = e.target.value;
  if (e.target.dataset.path) W.paths = { ...wizPaths(), [e.target.dataset.path]: e.target.value.trim() }; });
$('#welDlg').addEventListener('change', e => { if (e.target.dataset.path) wizRefresh(); });
$('#welDlg').addEventListener('toggle', e => { if (e.target.matches?.('[data-have]')) W.have = e.target.open; }, true);
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
  if (act === 'mission-open') { $('#welDlg').close(); setFocus('mission'); if (!live.empty) { live.adding = true; live.preview = null; } return renderMission(); }
  if (act === 'docs') return window.p9.openDocs('buttons-apps-and-pages').catch(() => {}); // RH2
  if (act === 'remote' || act === 'remote-retry') { W.remote = act === 'remote-retry' || !W.remote; if (W.remote) W.hosts = await window.p9.server().catch(() => null); return wizRender(); }
  if (act === 'connect') {
    const host = $('#welHost')?.value.trim() ?? '';
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/.test(host)) { W.note.remote = { error: 'host' }; return wizRender(); } // remote.mjs HOST
    // A new name joins the remote list first, as Settings > Remote's Add remote does; then main reloads the window onto it.
    const r = await run(() => (W.hosts?.remotes?.includes(host) ? Promise.resolve() : window.p9.remotes('add', host)).then(() => window.p9.server(host)).catch(() => ({ error: 'ipc-refused' })));
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
  // Row 61: the password goes to desktop main once; the field is emptied first.
  if (act === 'pw') {
    const field = $('#welDlg').querySelector(`[data-admin-pw="${agent}"]`), password = field?.value ?? '';
    if (field) field.value = '';
    const r = password ? await run(() => window.p9.adminInstall(agent, password).catch(() => ({ error: 'admin-failed' }))) : { error: 'password-empty' };
    W.note[agent] = r?.ok ? null : { error: r?.error || 'admin-failed' };
  }
  if (act === 'rdeps') {
    // Row 61 on a remote: the remote computes the command (its start script's deps); the admin window shows it and takes only the password.
    const host = serverInfo?.host || 'this remote', need = (W.s?.dependencies || []).filter(x => x.admin && ['tmux', 'ssh'].includes(x.id)).map(x => (ADMIN_NAMES[x.id] || x.id) + ': ' + x.why);
    const ask = async (error = '') => {
      const r = await run(() => window.p9.remoteDepsCheck().catch(() => ({ error: 'remote-deps-failed' })));
      if (!r?.command) { W.note.rdeps = { error: r?.error || 'remote-deps-failed' }; return wizRefresh(); }
      adminAsk(host, 'Install what P9 needs on ' + host, host + ' is missing what P9 needs, and only an admin can add it:', need, r.command, 'Install', error,
        res => { if (res?.error === 'wrong-password') return void ask('That password did not work. Check it and try again.'); W.note.rdeps = res?.ok ? null : { error: res?.error || 'admin-failed' }; void wizRefresh(); }, window.p9.remoteDeps);
    };
    W.note.rdeps = null;
    await ask();
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
liveChat.call = async (action, payload = {}, { quiet = false } = {}) => {
  const body = ['list', 'events', 'lock'].includes(action) ? payload : { op: crypto.randomUUID(), ...payload }, start = Date.now();
  let r = await window.p9.chat(action, body);
  // ponytail: one retry with the same operation ID after an unanswered request; the daemon replays it or says outcome-unknown.
  if (r.status === 503 && body.op) { await new Promise(res => setTimeout(res, 1000)); r = await window.p9.chat(action, body); }
  // The connecting screen already says why a remote does not answer, so a chat call failing under it raises no toast.
  // quiet: a background read the user did not start (loadSetup) says nothing; its caller shows what it needs.
  if (r.status >= 400 && !quiet && !$('#connecting')?.open && !(action === 'prompt' && r.body?.error === 'turn-running') && !(action === 'cancel' && r.body?.error === 'no-turn')) toast({ kind: 'chat', txt: chatFailed(action, r.body, Date.now() - start) ?? 'Chat ' + action + ': ' + (r.body?.error || r.status), level: 'bad' }, true);
  return r;
};
// N1: project, a uuid, only for a chat in a project: the daemon refuses null, and a general chat leaves the key out.
liveChat.create = async (agent, folder = '', project = null, model = '') => {
  const op = crypto.randomUUID(), f = { agent, model, op }; fresh.push(f);
  const r = await liveChat.call('create', { op, provider: agent, ...(folder && { folder }), ...(project && { project }) });
  if (r.status !== 201) { if (fresh.includes(f)) fresh.splice(fresh.indexOf(f), 1); }
  else if (!f.id) { // not claimed by its 'created' yet: that is still to come (claimFresh finds it by id), or came without op
    f.id = r.body.conversation; const s = S.sessions.find(x => x.id === f.id);
    if (s) { fresh.splice(fresh.indexOf(f), 1); startDefaults(s, model); renderChats(); }
  }
  if (r.status === 201 && folder) try { localStorage.setItem('eh-chat-folders', JSON.stringify([folder, ...recentFolders().filter(f => f !== folder)].slice(0, 5))); } catch {}
  return r;
};
// Builder, 2026-10-21: a refused prompt puts its text back in the box as well as its images, so nothing typed is lost.
// 2026-10-24: one refused because a turn runs is queued instead, and shown and kept as queued.
// D20: a send waits where it was made: Sending… in the chat's working row until the daemon takes it (a slow remote shows
// nothing else). Cleared on any answer.
liveChat.prompt = async (s, text, images = [], when) => { usedAgent(s.agent); s.working = true; s.done = false; s.sending = true; renderTabs(); renderChats(); const r = await liveChat.call('prompt', { id: s.id, text, mode: s.mode, ...(when && { when }),...(s.modelPick && { model: s.modelPick }), ...(Object.keys(s.pick || {}).length && { config: s.pick }), ...(images.length && { images: images.map(({ mimeType, data }) => ({ mimeType, data })) }) }).finally(() => { s.sending = false; }); if (r.status === 202) return renderChats(); s.images = [...images, ...(s.images || [])].slice(0, 4);
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
// A chat picture opens large in its own dialog (top layer, above #mdl); a click anywhere or Esc closes it.
const picDlg = $('#picDlg');
addEventListener('click', e => {
  const i = e.target.closest?.('.user-imgs img[src], .agent-imgs img'); if (!i) return;
  Object.assign(picDlg.firstElementChild, { src: i.src, alt: i.alt }); picDlg.showModal();
});
picDlg.onclick = () => picDlg.close();
addEventListener('click', async e => {
  const a = e.target.closest?.('a.link[href]'); if (!a || !window.p9?.openLink) return; // a browser preview follows the link
  e.preventDefault();
  if (await linkOk(a.href)) window.p9.openLink(a.href).catch(() => toast({ kind: 'link', txt: 'Link not opened', level: 'warn' }, true));
});

/* ---------- Send to server: the black hole and the switch (items 24, 25, specs/move-progress-events.md) ---------- */
// Drawn from main's p9:move stream only; the ledger's moving, moved and move-failed events stay the record. The overlay sits
// over the moving chat's pane, not in it (panes are morphed on every paint), and in its dialog when the pane is in one.
// ponytail: one move drawn at a time; another chat's events while one is drawn are not drawn (its ledger events still show).
const fx = $('#moveFx'), fxSky = createSky($('#moveSky')), moveDlg = $('#moveDlg');
// The chat's folder goes first, over P9's tunnel (item 23). A folder that needs a choice shows the Send files prompt before the chat
// is frozen (Builder, 2026-10-27: "Same prompt first"); a Syncthing folder sends none and keeps the wait ("Keep today's wait").
let fxFiles = null; // the chat whose move sends its folder first, for the uploading words
$('#moveCancel').onclick = () => { $('#moveCancel').hidden = true; $('#moveWhat').textContent = 'Cancelling…'; window.p9.cancelMove(FX.id).catch(() => {}); };
window.p9?.onMove?.(onMove);
// The server updates itself on connect (item 14, apps/desktop/server-update.mjs): each step as a toast; the end, and a
// server newer than this app, as an alert that stays until opened.
function onServerUpdate(u) {
  if (!u) return;
  const on = 'P9 on ' + u.host, missing = (u.missing ?? []).map(m => m.id + ' (' + m.why + '): ' + m.command).join('; ');
  const why = { 'turn-never-ended': 'a chat\'s turn did not end within 2 hours', 'still-older': 'its old P9 kept running after the reinstall; restart that computer or stop P9 there, then connect again' }[u.error] ?? u.error;
  const say = {
    downloading: [on + ' is downloading ' + u.version + ' from GitHub Releases.', 'ok'],
    building: [on + ' is building ' + u.version + ' beside the running copy.', 'ok'],
    'waiting-turns': [on + ' will update to ' + u.version + ': waiting for ' + u.turns + ' chat' + (u.turns === 1 ? '' : 's') + ' to finish ' + (u.turns === 1 ? 'its' : 'their') + ' turn.', 'ok'],
    restarting: [on + ' is restarting on ' + u.version + '.', 'ok'],
    done: [on + ' is now ' + u.version + '.', 'ok', true],
    'rolled-back': [on + (u.rolledBack ? ' did not start on ' + u.version + ' and went back to its old copy (' + u.reason + ').' : ' did not start on ' + u.version + ' and could not go back by itself (' + u.reason + '): see journalctl --user -u p9-foundation on the remote (or journalctl _SYSTEMD_USER_UNIT=p9-foundation.service where the journal is kept in memory).'), 'bad', true],
    failed: [on + ' was not updated to ' + u.version + ' (' + why + '). It runs on as before.', 'bad', true],
    'timed-out': [on + ' did not finish updating to ' + u.version + ' within ' + u.minutes + ' minutes. Connect again to see where it stands.', 'bad', true],
    'too-old': [on + ' runs ' + u.server + ', too old to update itself. Update it once by hand, in a terminal on ' + u.host + ' (from the folder P9 was cloned into):', 'bad', true],
    'app-older': ['The remote runs P9 ' + u.server + '; this app is ' + u.app + '. Update this app (Settings > Updates).', 'bad', true],
    // A connection that dropped on its own (owner, 2026-11-02): a notification. Disconnecting, or quitting with a Temporary
    // remote, closes it on purpose and says nothing; the remote stays in the machine menu either way.
    dropped: ['Lost the connection to ' + u.host + ' for 30 seconds. P9 keeps trying to connect again.', 'bad', true],
    unsupported: [on + ' cannot update itself (it is not a source checkout run by systemd). It stays on ' + u.server + '.', 'bad', true],
  }[u.phase];
  if (!say) return;
  // A remote before 0.1.6 (K1): the steps in a dialog at once, then connect again and it updates itself from then on.
  const steps = u.phase === 'too-old' ? ['git pull', 'pnpm install --frozen-lockfile', 'pnpm build', 'bash scripts/install.sh', 'systemctl --user restart p9-foundation'] : null;
  const a = { kind: u.phase === 'dropped' ? 'remote' : 'remote update', txt: say[0] + (missing ? ' Missing on the remote: ' + missing + ' (P9 never runs sudo).' : ''), level: say[1], ...(steps ? { steps, after: 'Then connect again: from 0.1.6 on, it updates itself when you connect.' } : {}) };
  toast(a, !say[2]);
  if (steps) openModal({ kind: 'alert', a });
}
window.p9?.onServerUpdate?.(onServerUpdate);
window.p9?.whatsNew?.().then(w => { if (w) openModal({ kind: 'whats-new', w }); }, () => {});
window.p9?.serverUpdate?.().then(onServerUpdate, () => {});
moveDlg.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.matches('button')) { e.preventDefault(); moveDlg.close('yes'); } });

addEventListener('focus', () => renderChats());
// Send to server shows only on this computer's chats, so the panes need the mode before Settings is first opened.
if (window.p9?.server) window.p9.server().then(r => { serverInfo = r; renderChats(); renderTree(); serverMenu(); if (r?.slim) { applySettings(); dataNote(); } }, () => {});
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
    + all.map(h => row(h, h === host ? SERVER_STATE[s.status === 'ok' ? 'ok' : s.error] ?? ['bad', 'Unreachable'] : probed(h) ? ['wait', 'Checking…'] : ['off', ''], h === host)).join('')
    + '<hr data-slot="separator" style="margin:6px 0">' + (host && s.slim && window.p9.remoteAgents ? '<button class="item" role="menuitem" id="serverAgents">AI agents on ' + esc(host) + '…</button>' : '')
    + (host ? '<button class="item" role="menuitem" id="serverDisconnect">Disconnect from ' + esc(host) + '</button>' : '')
    + '<button class="item" role="menuitem" id="serverAdd">Add a machine…</button>';
  pop.querySelectorAll('[data-server-go]').forEach(b => { b.onclick = () => { serverPop.close(); if (b.getAttribute('aria-current') !== 'true') window.p9.server(b.dataset.serverGo || null); }; });
  pop.querySelectorAll('[data-server-rm]').forEach(b => { b.onclick = async () => { const r = await window.p9.remotes('remove', b.dataset.serverRm).catch(() => null); if (r) { serverInfo.remotes = r.remotes; renderServerMenu(); } }; });
  all.filter(probed).forEach(h => window.p9.remoteState?.(h).then(st => {
    const b = pop.querySelector('[data-server-go="' + CSS.escape(h) + '"]'), [dot, say] = PROBE_STATE[st] ?? PROBE_STATE.unreachable;
    if (b) { b.querySelector('.srv-dot').dataset.s = dot; b.querySelector('.muted').textContent = say; }
  }, () => {}));
  // U9: the same switch as This computer above, said plainly.
  if (host) $('#serverDisconnect').onclick = () => { serverPop.close(); window.p9.server(null); };
  // Builder, 2026-11-02: the after-connect window again with only the agents question (Shell.tsx), now rather than at the next poll.
  if ($('#serverAgents')) $('#serverAgents').onclick = async () => { serverPop.close(); await window.p9.remoteAgents(null).catch(() => {}); dispatchEvent(new Event('p9:status-now')); };
  $('#serverAdd').onclick = async () => { serverPop.close(); await $('#setBtn').onclick(); settingsAt($('#setRemote')); $('#setRemoteName')?.focus(); };
}
if (chatOn()) side.open('dan-chat', danChat);
renderMission(); renderTabs(); renderChats(); renderTree(); renderDev(); setFocus('chat', true); loadMission().then(() => setTimeout(pollMission, 20000)); pollUsage(); loadChat(); checkSetup();
addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && e.code === 'KeyN') { e.preventDefault(); mdl.open && S.modal?.kind === 'center' ? closeModal() : openModal({ kind: 'center' }); } });
// mock: the hub's two open alerts arrive a few seconds after load. Sample view only: on the daemon they filled the
// bell with test data (Builder, 2026-10-18); live notices are P9's own alerts.
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

return () => { lifetime.abort(); timers.forEach(window.clearTimeout); observers.forEach(o => o.disconnect()); landVideo?.destroy(); };
}
