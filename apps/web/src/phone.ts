import { basicSetup, EditorView } from 'codemirror';
import { limitLine, sprintTimes, md, mdReply, imgSrc, toolImages, agentImgs, readImage, IMG_OK, MAX_IMAGES, modes, LOOSE } from './helpers.mjs';
import { pinned, applyCard } from './pinned.mjs';
import { artifactView, chipArtifact } from './artifact.mjs';
import { createTerminal, TMUX_MISSING, unavailableText } from './terminal.mjs';
import { svg as desktopIcons } from './helpers.mjs';
import { MAINTENANCE } from './maintenance.mjs';
import { SECURITY, warnsLoose, setWarnsLoose, setStarts, unrestricted } from './security.mjs';
import { missionKeys, missionShown, missionValue } from './mission-files.mjs';
import { FILE_PROTECTION_RISK } from '../../../packages/protocol/index.mjs';
import { DUWOP } from './theme-picker';
import { onLookChange } from './lib/theme';

type Json = Record<string, unknown>;
type Usage = { state: 'recorded' | 'stale' | 'unavailable'; updatedAt: number | null; samples: number; discarded: number; totals: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }; contexts: { provider: string; used: number; size: number }[]; limits?: { claude: Limits | null; codex: Limits | null; signedOut?: string[] } };
type Limits = { fiveHour: { usedPercent: number; resetsAt: number | null } | null; sevenDay: { usedPercent: number; resetsAt: number | null } | null; asOf: number };
const one = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const when = (ms: unknown) => new Date(Number(ms)).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
// L1: the message in the box is kept in this phone's storage (label() runs on every change of it), so a reload or a sign-in
// does not eat it. "restored" is the one kept from before this page loaded, waiting for its chat to open (route()).
let restored: { id: string; text: string } | null = (() => {
  try { const kept = JSON.parse(localStorage.getItem('p9-draft') ?? 'null'); return typeof kept?.id === 'string' && typeof kept.text === 'string' && kept.text.trim() ? kept : null; } catch { return null; }
})();
const state = { seen: Number(localStorage.getItem('p9-cursor') ?? 0), cursor: 0, events: [] as Json[], file: null as null | { path: string; hash: string; content: string; root?: string; disk?: { content: string; hash: string } }, conversations: [] as Json[], base: 0, replayed: false, stubs: new Set<string>() };
const editor = new EditorView({ parent: one('#editor'), extensions: [basicSetup, EditorView.lineWrapping, EditorView.updateListener.of((update) => { if (update.docChanged) syncSave(); }),
  EditorView.theme({ '&': { color: '#edf3fb', backgroundColor: '#0d131c' }, '.cm-content': { caretColor: '#6ee7f2' }, '&.cm-focused': { outline: 'none' }, '.cm-gutters': { backgroundColor: '#0d131c', color: '#65758d', border: 'none' } }, { dark: true })] });

// Save is live only once the draft differs from what was loaded (spec §6).
const dirty = () => !!state.file && editor.state.doc.toString() !== state.file.content;
function syncSave() { one<HTMLButtonElement>('#save').disabled = !navigator.onLine || !dirty(); }
function online() {
  const value = navigator.onLine;
  one<HTMLElement>('#stale').hidden = value;
  document.querySelectorAll<HTMLElement>('.sync').forEach((dot) => { dot.dataset.state = value ? 'live' : 'stale'; dot.setAttribute('aria-label', value ? 'Live' : 'Stale'); });
  document.querySelectorAll<HTMLButtonElement>('#save, [data-new], #newTerminal, #stopTerminal').forEach((button) => { button.disabled = !value || (button.id === 'save' && !dirty()); });
  label();
  return value;
}
// ---- Shell (phone spec §1, §4, §7): the pieces every screen shares. c7 lays the other tabs out with these. ----
const svg = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = { folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'), file: svg('<path d="M6 3h8l4 4v14H6z"/>'), refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>'), plus: svg('<path d="M12 5v14M5 12h14"/>'), back: svg('<path d="m15 5-7 7 7 7"/>'), chevron: svg('<path d="m7 10 5 5 5-5"/>'), up: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'), down: svg('<path d="M12 5v14M5 12l7 7 7-7"/>') };
type BarAction = { id?: string; label: string; icon: string; attrs?: string };
type BarOptions = { title: string; sub?: string; subId?: string; back?: { label: string; to: string }; acts?: BarAction[] };
// One top bar for every screen: 44 px (plus the safe area), the title left, the sync dot, at most a few icon actions.
// Callers pass trusted strings; text from the daemon goes through escape() first.
const topBar = (o: BarOptions) => (o.back ? `<button type="button" class="back" data-back="${o.back.to}" aria-label="Back to ${o.back.label}">${ICON.back}${o.back.label}</button>` : '')
  + `<div class="title"><h1>${o.title}</h1>${o.sub !== undefined || o.subId ? `<small${o.subId ? ` id="${o.subId}"` : ''}>${o.sub ?? ''}</small>` : ''}</div><span class="sync" role="img" aria-label="Live"></span>`
  + (o.acts ?? []).map((a) => `<button type="button"${a.id ? ` id="${a.id}"` : ''} aria-label="${a.label}"${a.attrs ? ' ' + a.attrs : ''}>${a.icon}</button>`).join('');
const mountBar = (name: string, o: BarOptions) => { one(`[data-bar="${name}"]`).innerHTML = topBar(o); };
mountBar('chat', chatsBar());
// Terminal (spec §6): the title is the picker, + starts one, ■ stops the open one; #termState is the line under the title.
mountBar('terminal', { title: `<button type="button" id="pickTerminal" class="pick" aria-label="Choose terminal"><span id="termTitle">Terminal</span>${ICON.chevron}</button>`, sub: 'No terminal open', subId: 'termState',
  acts: [{ id: 'newTerminal', label: 'New terminal', icon: ICON.plus }, { id: 'stopTerminal', label: 'Stop terminal', icon: ICON.stop }, { id: 'refreshTerminal', label: 'Refresh', icon: ICON.refresh }] });
one('#termState').setAttribute('role', 'status');
mountBar('mission', { title: 'Mission', acts: [{ id: 'refreshMission', label: 'Refresh', icon: ICON.refresh }] });
mountBar('usage', { title: 'Usage', acts: [{ id: 'refreshUsage', label: 'Refresh', icon: ICON.refresh }] });
// Files: one bar for the folder list and for an open file (the CSS shows one set), so #fileState, #up and #closeFile stay single elements.
one('[data-bar="files"]').innerHTML = `<button type="button" id="up" class="back" aria-label="Up one folder" disabled>${ICON.back}</button><button type="button" id="closeFile" class="back" aria-label="Back">${ICON.back}</button>`
  + '<div class="title"><h1><span id="dirPath">Workspace</span><span id="openPath"></span></h1><small id="fileState">Not loaded</small></div><span class="sync" role="img" aria-label="Live"></span>'
  + `<button type="button" id="save" disabled>Save</button><button type="button" id="moreFile" aria-label="More">${svg('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>')}</button>`;
// The hairline under a top bar shows only once its screen has scrolled.
one('main').addEventListener('scroll', (event) => { const box = event.target as HTMLElement; box.closest('section')?.querySelector(':scope > .bar')?.classList.toggle('ruled', box.scrollTop > 0); }, true);
// Bottom sheet: one shared <dialog>. Fill the body with .opt rows (or anything); a tap on the backdrop closes it.
const sheet = one<HTMLDialogElement>('#sheet');
let artSending: string | null = null, artEntries: string[][] = []; // item 19 (the artifact functions at the end of this file)
function openSheet(title: string, html: string) { one('#sheetTitle').textContent = title; one('#sheetBody').innerHTML = html; if (!sheet.open) sheet.showModal(); }
sheet.addEventListener('click', (event) => { if (event.target === sheet) sheet.close(); });
sheet.addEventListener('close', () => sheet.classList.remove('full')); // a full-screen sheet never leaks into the next openSheet() (New chat, Theme, Settings)
addEventListener('p9-sheet', (event) => { const { title, html, full } = (event as CustomEvent).detail; sheet.classList.toggle('full', full === true); openSheet(String(title), String(html)); }); // ponytail: the one door into the sheet for code outside this file and for its test; callers pass trusted HTML
// The app is a column the size of the visible viewport: when a keyboard opens, visualViewport shrinks (iOS Safari leaves
// the layout viewport alone and offsets the visual one), the column follows it, and the composer rides the keyboard. The
// tab bar hides while a keyboard is up: the visible height under 75% of the tallest this window has been.
// ponytail: a desktop window dragged much shorter reads as a keyboard too; the phone page never does that.
let tallest = innerHeight;
function fit() {
  const vv = window.visualViewport, height = vv?.height ?? innerHeight;
  tallest = Math.max(tallest, innerHeight);
  document.documentElement.style.setProperty('--vvh', height + 'px');
  document.documentElement.style.setProperty('--vvtop', (vv?.offsetTop ?? 0) + 'px');
  document.body.classList.toggle('kbd', height < tallest * 0.75);
}
window.visualViewport?.addEventListener('resize', fit); window.visualViewport?.addEventListener('scroll', fit); addEventListener('resize', fit); addEventListener('orientationchange', () => { tallest = 0; fit(); });
fit();
// L1: sign-in is the one place this page is thrown away, so what is unsent goes to storage first (the draft: label()) and
// the chat is named in the address, which the login page hands back (an exact #chat=<uuid>).
// P2: the file editor's unsaved text goes too (p9-file-draft, put back by keptFile() after the login), and so do Mission
// answers and the new idea not sent yet (p9-mission-draft, put back by keptMission()); the login page is told why it is
// shown (p9-ended), so a session that ended says so instead of a bare passkey page.
function toLogin() {
  forgetMission(); localStorage.removeItem('p9-csrf');
  try {
    if (dirty()) localStorage.setItem('p9-file-draft', JSON.stringify({ ...state.file, disk: undefined, text: editor.state.doc.toString() }));
    holdTyped(); if (Object.keys(typed.answers).length || typed.idea) localStorage.setItem('p9-mission-draft', JSON.stringify(typed));
    sessionStorage.setItem('p9-ended', '1');
  } catch {}
  location.replace('/login' + (openId ? '#chat=' + encodeURIComponent(openId) : ''));
}
// L1: the CSRF token outlives a closed or discarded tab (sessionStorage does not, and a phone drops it when the app is
// swiped away while the cookie lives on), so a reopened app does not sign in again. It is kept no longer than a session can
// last (auth.mjs SESSION_MAX_MS, 7 days; P2: the daemon ends it sooner when unused for 12 h), and a 401 or a login drops it.
const CSRF_MS = 7 * 24 * 3600 * 1000;
function csrfToken() {
  const tab = sessionStorage.getItem('p9-csrf'); if (tab) return tab;
  try {
    const kept = JSON.parse(localStorage.getItem('p9-csrf') ?? 'null');
    if (typeof kept?.token === 'string' && Date.now() - Number(kept.at) < CSRF_MS) { sessionStorage.setItem('p9-csrf', kept.token); return kept.token; }
  } catch {}
  return null;
}
async function request(path: string) {
  const response = await fetch(path, { cache: 'no-store' });
  if (response.status === 401) toLogin();
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(String(body.error ?? response.status)), { body });
  return body;
}
// One ID per action, kept until the daemon answers it: another action in between must not cost a lost one its ID,
// or its retry runs it twice (release r2 R2-5).
type Pending = { id: string; used?: boolean };
function keepPending(key: string, value?: Pending) {
  let all: Record<string, Pending> = {};
  try { const parsed = JSON.parse(localStorage.getItem('p9-pending') ?? '{}'); if (parsed && typeof parsed === 'object' && !('key' in parsed)) all = parsed; } catch {}
  if (value) all[key] = value; else delete all[key];
  localStorage.setItem('p9-pending', JSON.stringify(all));
  return all;
}
async function mutate(path: string, body: Json) {
  if (!online()) throw new Error('offline');
  const key = path + '\n' + JSON.stringify(body);
  const stored = keepPending('')[key];
  const pending: Pending = stored && !stored.used ? stored : { id: crypto.randomUUID() };
  keepPending(key, pending);
  const relogin = () => {
    keepPending(key, { ...pending, used: true });
    toLogin();
    return new Error('login-required');
  };
  // A reopened app keeps its cookie and, for the session's 12 hours, its CSRF token (csrfToken); with neither, log in again for a fresh one.
  const csrf = csrfToken();
  if (!csrf) throw relogin();
  let response: Response;
  try { response = await fetch(path, { method: path.startsWith('/files') ? 'PUT' : 'POST', headers: { 'content-type': 'application/json', 'x-p9-csrf': csrf, 'x-p9-op': pending.id }, body: JSON.stringify(body) }); }
  catch (error) { throw error; }
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) throw relogin();
  // Any answer, 503 included, is final for this ID (the daemon replays it); only a lost request keeps it for the retry (R1-7).
  keepPending(key);
  return { status: response.status, body: result };
}
let openId = ''; // the chat on the chat screen; '' is the Chats list
function show(view: string) {
  document.body.dataset.view = view;
  document.body.classList.toggle('inchat', view === 'chat' && !!openId);
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((section) => { section.hidden = section.dataset.view !== view; });
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((button) => button.setAttribute('aria-current', button.dataset.nav === view ? 'page' : 'false'));
  if (view === 'mission') { if (!missionDrawn && lastMission) void loadMission(true); void loadMission(); }
  if (view === 'usage') void loadUsage();
  if (view === 'files' && !state.file) void loadFolder();
  if (view === 'terminal' && !term.open) void loadTerminals();
}
document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((button) => { button.onclick = () => show(button.dataset.nav!); });

// One load at a time, in order: the page's first load, still reading when New is tapped, must not refill the picker
// after the newer one with a list from before the new chat (it put the old chat back, and its mode with it).
let loads = Promise.resolve();
const loadChat = () => loads = loads.then(readChat);
async function readChat() {
  try {
    const list = await request('/chat'); state.conversations = list.conversations ?? [];
    await fetchEvents(); // the first read relists (PH3), so the picker is filled after it
    fillPicker();
    if (!linked && applyLink()) { linked = true; route(one<HTMLSelectElement>('#conversation').value); } else render();
  } catch { one('#events').innerHTML = one('#chatList').innerHTML = '<div class="empty">Chat is unavailable.</div>'; }
}
// Most recently used first, in the daemon's order (owner, 2026-10-25): the open chats, then History, the stopped ones a
// message was sent in, as on the desktop. Labelled with when it started and its state, so two "Claude" chats are told
// apart. The chat shown stays picked.
function fillPicker() {
  const select = one<HTMLSelectElement>('#conversation'), was = select.value;
  const option = (item: Json) => `<option value="${escape(item.id)}">${escape(`${item.title || item.provider} · ${when(item.created)} · ${item.state}`)}</option>`;
  const group = (label: string, items: Json[]) => items.length ? `<optgroup label="${label}">${items.map(option).join('')}</optgroup>` : '';
  select.innerHTML = group('Open', state.conversations.filter((item) => item.state !== 'stopped')) + group('History', state.conversations.filter((item) => item.state === 'stopped' && item.sent))
    || '<option value="">No conversations yet</option>';
  // An open chat stays picked even when it left the list (stopped before its first message, or closed): the select's
  // fallback to its first (newest) option sent that chat's composer to another chat. On the list the newest is the default.
  if (openId) select.value = openId;
  else if ([...select.options].some((option) => option.value === was)) select.value = was;
}
// P10: a new chat can start in a folder a recent chat used (the daemon's list is newest first); the desktop's
// folder dialog has no phone form, so a new folder is picked there once. Shown in the New chat sheet.
function startIn() {
  const folders = [...new Set(state.conversations.map((item) => String(item.folder ?? '')).filter(Boolean))].slice(0, 8);
  return folders.length ? `<select id="startIn" aria-label="Start in"><option value="">Start in: Workspace</option>${folders.map((item) => `<option value="${escape(item)}">Start in: ${escape(item)}</option>`).join('')}</select>` : '';
}
// PH1: "Continue on phone" on the desktop opens /phone#chat=<id>; that chat is shown (once on load, and again when the
// link changes on an open page).
let linked = false;
function applyLink() {
  const id = new URLSearchParams(location.hash.slice(1)).get('chat'), select = one<HTMLSelectElement>('#conversation');
  if (!id || ![...select.options].some((option) => option.value === id)) return false;
  select.value = id;
  return true;
}
addEventListener('hashchange', () => { if (applyLink()) { show('chat'); route(one<HTMLSelectElement>('#conversation').value); } else if (openId) route(''); });
// Reads every event after state.cursor into state.events (the daemon pages 500 at a time); wait > 0 long-polls for the
// first. `extra` narrows it to some chats (the first read, PH3). The page holds what it has read, so a reload or a second
// visit shows each chat in full.
async function pull(extra: string, wait = 0) {
  let batch: Json[];
  do {
    const result = await request('/chat/events?after=' + state.cursor + '&wait=' + wait + extra); wait = 0;
    batch = result.events as Json[] ?? [];
    // The live loop and a refresh can overlap; an event already held is skipped.
    for (const event of batch) if (Number(event.cursor) > state.cursor) { state.events.push(event); state.cursor = Number(event.cursor); }
    // A narrowed read reports how far it scanned, matching or not.
    if (extra && batch.length < 500) state.cursor = Math.max(state.cursor, Number(result.cursor));
  } while (batch.length === 500);
}
// A saved cursor whose next events were pruned is a gap; a first visit (nothing saved) is not.
const gapAfter = (next?: Json) => { if (state.seen > 0 && next && Number(next.cursor) > state.seen + 1) one<HTMLElement>('#gap').hidden = false; };
// PH3: the first read replays only the chats that are not stopped, as the desktop does (E2); a stopped chat's history
// loads when it is shown. Before this the phone read the whole ledger, stopped chats included, on every launch.
// ponytail: over 100 such chats it replays everything, as the desktop does (their IDs go in the URL).
async function replay() {
  const ids = state.conversations.filter((item) => item.state !== 'stopped').map((item) => String(item.id));
  let scoped = ids.length <= 100;
  for (;;) {
    // P20: a chat that is not stopped starts with its newest blocks only; Load earlier reads the ones before.
    try { if (!scoped) await pull(''); else { const result = await request('/chat/events?after=0&tail=' + TAIL + '&only=' + ids.map(encodeURIComponent).join(',')); take(result, ids); state.cursor = Math.max(state.cursor, Number(result.cursor)); } break; }
    // A listed ID the daemon will not take (only a seeded test ledger has one) replays everything, as before.
    catch (error) { if (!scoped || (error as Error).message !== 'request-refused') throw error; scoped = false; }
  }
  if (!scoped) return gapAfter(state.events.find((event) => Number(event.cursor) > state.seen));
  // The narrowed events skip the other chats', so a gap is looked for in the whole feed: its first event after the saved cursor.
  if (state.seen > 0) gapAfter(((await request('/chat/events?after=' + state.seen + '&wait=0')).events as Json[] | undefined)?.[0]);
  // Listed again after the read: a chat made meanwhile has events below base this read did not take, so it is a stub too.
  state.base = state.cursor;
  state.conversations = (await request('/chat')).conversations ?? [];
  state.stubs = new Set(state.conversations.map((item) => String(item.id)).filter((id) => !ids.includes(id)));
  // A chat made during the read is open, not history: the list reads its state from its events (P7), so they load now.
  // Left a stub, a chat started while the phone loads showed idle until it was opened.
  await Promise.all(state.conversations.filter((item) => item.state !== 'stopped' && state.stubs.has(String(item.id))).map((item) => history(String(item.id))));
}
async function fetchEvents(wait = 0) {
  if (!state.replayed) { await replay(); state.replayed = true; }
  else { await pull('', wait); gapAfter(state.events.find((event) => Number(event.cursor) > state.seen)); }
  state.seen = state.cursor; localStorage.setItem('p9-cursor', String(state.cursor));
}
// P20: a tail read's events go in once each, in cursor order. older holds, per chat, the first cursor read when
// older events were left out; Load earlier reads up to the one before it.
const TAIL = 30, older = new Map<string, number>();
let changedEarlier = ''; // the chat the Load earlier button was last reset for
function take(result: Json, ids: string[]) {
  const held = new Set(state.events.map((event) => Number(event.cursor)));
  state.events.push(...(result.events as Json[]).filter((event) => !held.has(Number(event.cursor))));
  state.events.sort((a, b) => Number(a.cursor) - Number(b.cursor));
  const more = (result.more ?? {}) as Json;
  for (const id of ids) if (typeof more[id] === 'number') older.set(id, more[id] as number); else older.delete(id);
}
// A stub chat's newest events, up to where the first read stopped; live events for it come after, so none repeat.
const loading = new Map<string, Promise<void>>();
function history(id: string) {
  if (!state.stubs.has(id)) return Promise.resolve();
  if (!loading.has(id)) loading.set(id, (async () => {
    try {
      take(await request('/chat/events?after=0&tail=' + TAIL + '&only=' + encodeURIComponent(id) + '&until=' + state.base), [id]);
    } catch (error) { if ((error as Error).message !== 'request-refused') throw error; } // an ID the daemon will not take has no history to show
    state.stubs.delete(id);
  })().finally(() => loading.delete(id)));
  return loading.get(id)!;
}
// One readable block per message: streamed chunks are joined, a tool call keeps its latest status, and bookkeeping
// updates (usage, commands, titles) are left out. Each block is one <article data-kind=…> in #events.
type Block = { kind: string; text: string; id?: unknown; status?: string; detail?: string; request?: string; options?: Json[]; closed?: boolean; images?: string[]; plan?: string; form?: Json[] | null; sent?: string[] };
type Attached = { mimeType: string; data: string; name: string };
const attached = new Map<string, Attached[]>(), sentCache = new Map<string, string>(); // P8, below the composer
// P10: an agent's question answered on the phone, from the daemon's checked form (formSpec in chat.mjs), as the desktop
// answers it. null: a form P9 cannot show faithfully, which can only be declined here. Inputs are named f<i> (f<i>~<j>
// for a multi choice); an empty optional field is left out of the answer.
function questionForm(request: string, fields: Json[] | null) {
  const choice = (name: string, options: [string, string][], required: boolean) => [...(required ? [] : [['', 'No answer'] as [string, string]]), ...options]
    .map(([value, text], j) => `<label class="pick"><input type="radio" name="${name}" value="${escape(value)}"${!required && !j ? ' checked' : ''}${required ? ' required' : ''}> ${escape(text)}</label>`).join('');
  const field = (f: Json, i: number) => {
    const name = 'f' + i, options = (f.options ?? []) as [string, string][], required = f.required === true;
    const input = f.kind === 'choice' ? choice(name, options, required) : f.kind === 'boolean' ? choice(name, [['true', 'Yes'], ['false', 'No']], required)
      : f.kind === 'multi' ? options.map(([value, text], j) => `<label class="pick"><input type="checkbox" name="${name}~${j}" value="${escape(value)}"> ${escape(text)}</label>`).join('')
      : `<input name="${name}" type="${f.kind === 'text' ? 'text' : 'number'}"${f.kind === 'integer' ? ' step="1"' : f.kind === 'number' ? ' step="any"' : ''}${required ? ' required' : ''}${f.min != null ? ` ${f.kind === 'text' ? 'minlength' : 'min'}="${Number(f.min)}"` : ''}${f.max != null ? ` ${f.kind === 'text' ? 'maxlength' : 'max'}="${Number(f.max)}"` : ''}>`;
    return `<fieldset><legend>${escape(f.label)}${required ? ' *' : ''}</legend>${f.hint ? `<small>${escape(f.hint)}</small>` : ''}${input}</fieldset>`;
  };
  return `<form class="question" data-question="${escape(request)}">${fields ? fields.map(field).join('') : '<p class="empty">P9 cannot show this form faithfully. Decline, or answer on the desktop.</p>'}`
    + `<div class="actions start">${fields ? '<button type="submit">Answer</button>' : ''}<button type="button" class="quiet" data-decline>Decline</button></div></form>`;
}
function questionAnswer(form: HTMLFormElement, fields: Json[]) {
  const values = new FormData(form), content: Record<string, unknown> = {};
  fields.forEach((f, i) => {
    const value = f.kind === 'multi' ? ((f.options ?? []) as [string, string][]).filter((_, j) => values.has(`f${i}~${j}`)).map(([v]) => v) : String(values.get('f' + i) ?? '');
    if (!f.required && (value === '' || (Array.isArray(value) && !value.length))) return;
    content[String(f.key)] = f.kind === 'number' || f.kind === 'integer' ? Number(value) : f.kind === 'boolean' ? value === 'true' : value;
  });
  return content;
}
type Entry = { key: string; sig: string; html: () => string };
type Strip = { events: { t: string; entries: unknown }[]; cards?: Map<string, unknown> };
const DETAIL_CAP = 2000; // a tool call's expandable detail: the ledger's status and text content, escaped, capped (threat model row 18)
const toolText = (data: Json) => (Array.isArray(data.content) ? data.content as Json[] : []).map((item) => String(((item.content ?? item) as Json | undefined)?.text ?? '')).filter(Boolean).join('\n');
function build(picked: string) {
  const blocks: Block[] = [];
  // PH4: the plan and the pinned cards, drawn by the desktop's own strip (pinned.mjs) from the same ledger events.
  const strip: Strip = { events: [] };
  const add = (kind: string, text: unknown, extra: Partial<Block> = {}) => { blocks.push({ kind, text: String(text ?? ''), ...extra }); };
  // An approval keeps its buttons until it is answered or its turn ends (a daemon restart or Stop drops it unanswered).
  const settle = () => blocks.forEach((block) => { if (block.request) { block.request = undefined; block.text += ' · not answered'; } if (block.kind === 'ask') block.closed = true; });
  for (const event of state.events) {
    if (event.conversation !== picked) continue;
    const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Json, kind = String(event.type), last = blocks.at(-1);
    // A moved chat's first message also carried P9's note about the folder: shown, so the history has what the agent was told.
    if (kind === 'user' && typeof data.note === 'string') add('note', 'P9 told the agent · ' + data.note.trim());
    if (kind === 'user') add('user', data.text, { sent: (Array.isArray(data.images) ? data.images : []).map((image: Json) => String(image?.hash)).filter((hash: string) => /^[0-9a-f]{64}$/.test(hash)) });
    else if (kind === 'update') {
      const update = String(data.sessionUpdate), text = (data.content as Json | undefined)?.text ?? '';
      if (update === 'agent_message_chunk' || update === 'agent_thought_chunk') {
        const type = update === 'agent_message_chunk' ? 'agent' : 'think';
        if (last?.kind === type) last.text += String(text); else add(type, text);
        // P9: an agent's own image (threat model row 26), checked by the desktop's helper, shows under its text.
        const image = type === 'agent' && imgSrc(data.content); if (image) (blocks.at(-1)!.images ??= []).push(image);
      } else if (update === 'plan') strip.events = [{ t: 'plan', entries: (Array.isArray(data.entries) ? data.entries as Json[] : []).map((entry) => [String(entry?.status), String(entry?.content ?? '')]) }];
      else if (update === 'tool_call') add('tool', data.title || 'Tool call', { id: data.toolCallId, status: String(data.status || 'pending'), detail: toolText(data).slice(0, DETAIL_CAP), images: toolImages(data.content), plan: artPlan(data) });
      else if (update === 'tool_call_update') {
        const tool = blocks.find((block) => block.kind === 'tool' && block.id === data.toolCallId);
        if (tool) {
          if (typeof data.status === 'string') tool.status = data.status;
          if (typeof data.title === 'string' && data.title) tool.text = data.title;
          const more = toolText(data); if (more) tool.detail = ((tool.detail ? tool.detail + '\n' : '') + more).slice(0, DETAIL_CAP);
          if (data.content) tool.images = toolImages(data.content);
        }
      }
    }
    else if (kind === 'card' || kind === 'unpin') applyCard(strip, kind, data);
    else if (kind === 'approval') add('approval', (data.toolCall as Json | undefined)?.title || 'Tool call', { request: String(data.request), options: Array.isArray(data.options) ? data.options as Json[] : [] });
    else if (kind === 'answered') {
      const asked = blocks.find((block) => block.request === data.request), answer = (data.answer ?? {}) as Json, outcome = answer.outcome as Json | undefined;
      if (asked) asked.request = undefined;
      const question = blocks.find((block) => block.kind === 'ask' && block.id === data.request); if (question) question.closed = true;
      const chosen = asked?.options?.find((option) => option.optionId === outcome?.optionId);
      add('answered', 'You answered · ' + (outcome ? (outcome.outcome === 'selected' ? String(chosen?.name ?? outcome.optionId) : 'Cancelled') : (({ accept: 'Answered', decline: 'Declined' } as Json)[String(answer.action)] ?? 'Cancelled')));
    }
    else if (kind === 'question') add('ask', data.message, { id: data.request, form: ((data.form as Json | null)?.fields as Json[] | undefined) ?? null });
    else if (kind === 'turn-end') { settle(); if (data.stopReason !== 'end_turn') add('note', 'Turn ended · ' + data.stopReason); }
    else if (kind === 'error') add('error', data.message);
    else if (kind === 'steer-lost') add('note', 'This message may not have reached the agent · ' + data.text);
    else if (kind === 'interrupted') { settle(); add('note', 'Stopped · The P9 daemon restarted mid-turn. Send again to resume.'); }
    else if (kind === 'exited' || kind === 'stopped') { settle(); add('note', 'Stopped · Send again to resume.'); }
  }
  return { blocks, strip };
}
const toolRow = (block: Block) => `<article data-kind="tool" data-status="${escape(block.status)}">${block.plan ? `<button type="button" class="open-plan" data-art-plan="${escape(block.plan)}">Open plan</button>` : ''}<details><summary><span class="st"></span><span class="t">${escape(block.text)}</span></summary><pre>${escape([block.status, block.detail].filter(Boolean).join('\n'))}</pre></details>${agentImgs(block.images, 'the agent')}</article>`;
function blockHtml(block: Block) {
  const kind = block.kind;
  if (kind === 'user') return `<article data-kind="user" class="msg user">${escape(block.text)}${sentImgs(openId, block.sent)}</article>`;
  if (kind === 'agent') return `<article data-kind="agent" class="msg md">${mdReply.parse(block.text)}${agentImgs(block.images, 'the agent')}</article>`;
  if (kind === 'think') return `<article data-kind="think"><details><summary>Thinking</summary><div>${escape(block.text)}</div></details></article>`;
  if (kind === 'tool') return toolRow(block);
  // P10: an open question is answered here, from the daemon's checked form.
  if (kind === 'ask' && !block.closed) return `<article data-kind="ask" class="msg ask open"><div>${escape(block.text)}</div>${questionForm(String(block.id), block.form ?? null)}</article>`;
  if (kind === 'approval' || kind === 'ask') {
    const open = kind === 'ask' ? !block.closed : !!block.request;
    return `<article data-kind="${kind}" class="msg ask${open ? ' open' : ''}"><div>${escape(block.text)}</div>${block.request ? `<div class="actions start">${(block.options ?? []).map((option) =>
      `<button class="${String(option.kind).startsWith('reject') ? 'quiet' : ''}" data-request="${escape(block.request)}" data-option="${escape(option.optionId)}">${escape(option.name || option.optionId)}</button>`).join('')}</div>` : ''}</article>`;
  }
  return `<article data-kind="${kind}" class="note">${escape(block.text)}</article>`;
}
// Three or more tool calls in a row fold into one row. A block's key is its index (a group's is its first block's), so a
// node is kept while its signature holds; a streaming reply re-renders only its own node.
function itemsOf(blocks: Block[]) {
  const out: Entry[] = [];
  for (let i = 0; i < blocks.length; i++) {
    let j = i; while (blocks[j].kind === 'tool' && blocks[j + 1]?.kind === 'tool') j++;
    if (j - i >= 2) {
      const run = blocks.slice(i, j + 1);
      out.push({ key: 'g' + i, sig: JSON.stringify(run), html: () => `<article data-kind="group" data-status="${run.some((block) => block.status === 'in_progress' || block.status === 'pending') ? 'in_progress' : 'completed'}"><details><summary><span class="st"></span><span class="t">Ran ${run.length} tools</span></summary>${run.map(toolRow).join('')}</details></article>` });
      i = j;
    } else { const block = blocks[i]; out.push({ key: 'b' + i, sig: JSON.stringify(block) + (block.sent ?? []).map((hash) => sentCache.get(hash) ? 1 : 0).join(''), html: () => blockHtml(block) }); }
  }
  return out;
}
type Keyed = HTMLElement & { sig?: string };
// Appends and patches: every node whose key and signature still hold stays in the page (scroll position, text selection and
// an expanded row survive a long-poll tick); only a changed block is replaced, a new one inserted, a gone one removed.
function patch(list: HTMLElement, wanted: Entry[]) {
  for (const node of [...list.children]) if (!(node as HTMLElement).dataset.key) node.remove(); // notes and "Loading…" last one render
  const have = new Map<string, Keyed>(), keep = new Set(wanted.map((item) => item.key));
  for (const node of [...list.children] as Keyed[]) if (keep.has(node.dataset.key!)) have.set(node.dataset.key!, node); else node.remove();
  const template = document.createElement('template'); let prev: Element | null = null;
  for (const item of wanted) {
    let node = have.get(item.key);
    if (!node || node.sig !== item.sig) {
      template.innerHTML = item.html();
      const fresh = template.content.firstElementChild as Keyed;
      fresh.dataset.key = item.key; fresh.sig = item.sig;
      if (node) { const was = [...node.querySelectorAll('details')].map((details) => details.open); fresh.querySelectorAll('details').forEach((details, index) => { details.open = was[index] ?? false; }); node.replaceWith(fresh); }
      node = fresh;
    }
    const expected: Element | null = prev ? prev.nextElementSibling : list.firstElementChild;
    if (node !== expected) list.insertBefore(node, expected);
    prev = node;
  }
}
// P7: what each chat is doing, read from its events the way the desktop's robot heads are: a user message with no turn end
// after it is working; an approval or question not yet answered is waiting on you; otherwise stopped.
type Digest = { run: 'working' | 'needs' | 'idle'; last: string };
function digest() {
  const seen = new Map<string, { working: boolean; open: Set<string>; last: string; tail: boolean }>();
  for (const event of state.events) {
    const id = String(event.conversation), kind = String(event.type), data = (event.data && typeof event.data === 'object' ? event.data : {}) as Json;
    let chat = seen.get(id); if (!chat) seen.set(id, chat = { working: false, open: new Set(), last: '', tail: false });
    if (kind === 'user') { chat.working = true; chat.last = String(data.text ?? ''); chat.tail = false; }
    else if (kind === 'update') {
      const update = String(data.sessionUpdate), text = String((data.content as Json | undefined)?.text ?? '');
      if (update === 'agent_message_chunk') { chat.last = chat.tail ? chat.last + text : text; chat.tail = true; }
      else if (update === 'tool_call') chat.tail = false;
    }
    else if (kind === 'approval' || kind === 'question') chat.open.add(String(data.request));
    else if (kind === 'answered') chat.open.delete(String(data.request));
    else if (['turn-end', 'interrupted', 'exited', 'stopped', 'closed', 'error'].includes(kind)) { chat.working = false; chat.open.clear(); }
  }
  const out = new Map<string, Digest>();
  seen.forEach((chat, id) => out.set(id, { run: chat.open.size ? 'needs' : chat.working ? 'working' : 'idle', last: chat.last.trim().split('\n')[0] ?? '' }));
  return out;
}
const clock = (ms: unknown) => { const date = new Date(Number(ms)); return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
let listSig = '';
function renderList() {
  const found = digest(), row = (item: Json) => {
    const id = String(item.id), info = found.get(id), run = info?.run ?? 'idle', second = run === 'working' ? 'Working…' : run === 'needs' ? 'Needs you' : (info?.last ?? '');
    return `<button type="button" class="row" data-chat="${escape(id)}" data-run="${run}"><i class="dot ${escape(item.provider)}"></i><span class="t"><b>${escape(item.title || item.provider)}</b><small>${escape(second)}</small></span><time>${escape(clock(item.used ?? item.created))}</time></button>`;
  };
  const section = (label: string, items: Json[]) => items.length ? `<h2 class="sec">${label}</h2>${items.map(row).join('')}` : '';
  const html = section('Open', state.conversations.filter((item) => item.state !== 'stopped')) + section('History', state.conversations.filter((item) => item.state === 'stopped' && item.sent))
    || '<div class="empty">No chats yet. Tap + to start one.</div>';
  if (html !== listSig) { listSig = html; one('#chatList').innerHTML = html; }
}
// The chat screen's top bar: back, the chat's title with its agent and model (tap: the Model sheet), a status.
let barSig = '';
function chatBar(id: string, run: string) {
  const item = state.conversations.find((entry) => entry.id === id), model = one<HTMLSelectElement>('#model');
  const name = model.selectedOptions[0]?.textContent || '', agent = item?.provider === 'codex' ? 'Codex' : 'Claude';
  const html = `<button type="button" class="back" data-back aria-label="Back to Chats">${ICON.back}Chats</button><div class="title"><h1>${escape(item?.title || agent)}</h1><button type="button" class="sub" id="modelBtn" aria-label="Model">${escape(agent + (name ? ' · ' + name : ''))} ${ICON.chevron}</button></div>${run === 'idle' ? '<span class="run" data-run="idle" role="img" aria-label="Stopped"></span>' : `<button type="button" class="run" id="stopTurn" data-run="${run}" aria-label="Stop"></button>`}<span class="sync" role="img" aria-label="Live"></span>`;
  if (html === barSig) return;
  barSig = html; const bar = one('[data-bar="chat"]'); bar.innerHTML = html; online();
}
// Where the reader is: the list ('') or a chat. Opening pushes a history entry (#chat=<id>, as "Continue on phone" links),
// so the browser's own back, the iOS edge swipe included, returns to the list.
let pushed = false, stuck = true, windowSize = 60, hiddenBlocks = 0, anchored = false, seenItems = 0;
const body = one<HTMLElement>('#chatBody');
function route(id: string) {
  const changed = id !== openId; openId = id;
  const select = one<HTMLSelectElement>('#conversation'); if (id) select.value = id;
  one<HTMLElement>('#chatList').hidden = !!id; one<HTMLElement>('#chatArea').hidden = !id; one<HTMLElement>('#composerSlot').hidden = !id;
  document.body.classList.toggle('inchat', !!id && document.body.dataset.view === 'chat');
  barSig = '';
  if (!id) { pushed = false; mountBar('chat', chatsBar()); online(); renderList(); return; }
  if (changed) { one('#events').replaceChildren(); windowSize = 60; seenItems = 0; stuck = true; one<HTMLElement>('#jump').hidden = true; }
  render();
  // L1: the unsent message from before the page was last thrown away (a sign-in, a reload) goes back in its own chat's box.
  const box = one<HTMLTextAreaElement>('#prompt');
  if (restored?.id === id && !box.value) { box.value = restored.text; label(); }
}
function openChat(id: string) { window.history.pushState(null, '', '#chat=' + encodeURIComponent(id)); pushed = true; route(id); }
function back() { if (pushed) window.history.back(); else { window.history.replaceState(null, '', location.pathname + location.search); route(''); } }
function render() {
  if (!openId) return renderList();
  const picked = openId;
  if (state.stubs.has(picked)) {
    one('#events').innerHTML = '<div class="empty">Loading…</div>';
    history(picked).then(render, () => { one('#events').innerHTML = '<div class="empty">Chat is unavailable.</div>'; });
    return;
  }
  const { blocks, strip } = build(picked), all = itemsOf(blocks), events = one<HTMLElement>('#events');
  if (!stuck && seenItems) windowSize += Math.max(0, all.length - seenItems); // a reader part way up keeps their top; the window slides only at the bottom
  seenItems = all.length;
  const shown = all.slice(-windowSize);
  hiddenBlocks = all.length - shown.length;
  const earlier = one<HTMLButtonElement>('#earlier');
  earlier.hidden = !older.has(picked) || hiddenBlocks > 0; // what is read is drawn first, as the reader scrolls up
  if (changedEarlier !== picked) { changedEarlier = picked; earlier.disabled = false; earlier.textContent = 'Load earlier'; }
  const height = body.scrollHeight, top = body.scrollTop;
  patch(events, shown);
  if (!blocks.length) events.insertAdjacentHTML('beforeend', '<div class="empty">No messages yet.</div>');
  if (stuck) body.scrollTop = body.scrollHeight; else if (anchored) body.scrollTop = top + body.scrollHeight - height; // older blocks inserted above keep the reader where they were
  anchored = false;
  const plan = (strip.events[0]?.entries ?? []) as string[][], cards = strip.cards?.size ?? 0, chips = one<HTMLElement>('#chips');
  artEntries = plan; // item 19: the plan view reads the entries shown
  one('#pinned').innerHTML = pinned(strip, (card: { text: string }) => md.parse(card.text) as string);
  chips.hidden = !plan.length && !cards;
  chips.innerHTML = (plan.length ? `<button type="button" class="chip" data-chip>Plan ${plan.filter((entry) => entry[0] === 'completed').length}/${plan.length} ▸</button>` : '') + (cards ? `<button type="button" class="chip" data-chip>${cards} pinned ▸</button>` : '');
  chatBar(picked, digest().get(picked)?.run ?? 'idle');
  renderPicks(picked); renderQueue(); renderAttached(); label(); void drain();
}
// P20: the next TAIL blocks before the oldest read, drawn above; the reader stays where they were.
one('#earlier').addEventListener('click', async () => {
  const id = openId, from = older.get(id), button = one<HTMLButtonElement>('#earlier');
  if (!id || from === undefined || button.disabled) return;
  button.disabled = true; button.textContent = 'Loading…';
  try {
    take(await request('/chat/events?after=0&tail=' + TAIL + '&only=' + encodeURIComponent(id) + '&until=' + (from - 1)), [id]);
    button.disabled = false; button.textContent = 'Load earlier';
    if (openId === id) { anchored = true; render(); }
  } catch { button.disabled = false; button.textContent = 'Not loaded · Tap to try again'; }
});
body.addEventListener('scroll', () => {
  stuck = body.scrollHeight - body.scrollTop - body.clientHeight < 80; one<HTMLElement>('#jump').hidden = stuck;
  if (body.scrollTop < 60 && hiddenBlocks > 0) { windowSize += 60; anchored = true; render(); } // older history loads when the reader reaches the top
}, { passive: true });
new ResizeObserver(() => { if (stuck) body.scrollTop = body.scrollHeight; }).observe(body);
new ResizeObserver(() => { if (stuck) body.scrollTop = body.scrollHeight; }).observe(one('#events'));
one<HTMLButtonElement>('#jump').innerHTML = ICON.down;
one<HTMLButtonElement>('#jump').onclick = () => body.scrollTo({ top: body.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
one<HTMLElement>('#chips').onclick = (event) => { if ((event.target as Element).closest('[data-chip]')) openSheet('Plan and pinned', one('#pinned').innerHTML); };
one<HTMLElement>('#chatList').onclick = (event) => { const row = (event.target as Element).closest<HTMLElement>('[data-chip],[data-chat]'); if (row?.dataset.chat) openChat(row.dataset.chat); };
// L3: a turn that runs can be stopped from the top bar, where its status ring is (the composer's send button turns into Stop
// only when the box is empty and nothing is queued). The route is the composer's and the desktop's: POST /chat/:id/cancel.
async function stopChat(id: string) {
  if (!id) return;
  const result = await mutate('/chat/' + encodeURIComponent(id) + '/cancel', {});
  if (result.status !== 200 && result.body.error !== 'no-turn') note(`Not stopped: ${result.body.error ?? result.status}`);
  await fetchEvents(); render();
}
one('[data-bar="chat"]').addEventListener('click', (event) => {
  const button = (event.target as Element).closest('button'); if (!button) return;
  if (button.dataset.back !== undefined) back();
  else if (button.id === 'stopTurn') stopChat(openId);
  else if (button.id === 'newChat') openSheet('New chat', `<button type="button" class="opt" data-new="claude">New Claude chat</button><button type="button" class="opt" data-new="codex">New Codex chat</button>${startIn()}`);
  else if (button.id === 'modelBtn') {
    const model = one<HTMLSelectElement>('#model'), options = [...model.options];
    openSheet('Model', options.length ? options.map((option) => `<button type="button" class="opt" data-model="${escape(option.value)}" aria-checked="${option.selected}">${escape(option.textContent)}</button>`).join('') : '<div class="empty">This agent lists no models.</div>');
    // L4: Send to server is desktop-only by design (a chat on this phone already runs on the server), so say where it lives.
    one('#sheetBody').insertAdjacentHTML('beforeend', '<p class="empty">Send to remote is in the desktop app, on a chat that runs on that computer. A chat here is already on the remote.</p>');
  }
});
one('#sheetBody').addEventListener('click', async (event) => {
  const target = event.target as Element, pick = target.closest<HTMLElement>('[data-model]'), make = target.closest<HTMLElement>('[data-new]');
  if (pick) { const model = one<HTMLSelectElement>('#model'); model.value = pick.dataset.model!; model.dispatchEvent(new Event('change')); barSig = ''; sheet.close(); render(); }
  if (make) {
    if (!navigator.onLine) return;
    const folder = document.querySelector<HTMLSelectElement>('#startIn')?.value;
    sheet.close();
    const result = await mutate('/chat', { provider: make.dataset.new, ...(folder && { folder }) });
    if (result.status !== 201) return;
    // A loosened last pick carries to a new chat only after "don't show again": a plain "Turn on" was for that chat (review #2).
    const last = localStorage.getItem('p9-mode:' + make.dataset.new);
    if (last && (!(last in LOOSE) || localStorage.getItem('p9-mode-ok:' + last))) startPick.set(String(result.body.conversation), last);
    await loadChat(); openChat(String(result.body.conversation));
  }
});
// Mode and Model for the picked chat (Builder, 2026-10-18: the phone could change neither; threat model row 15). An open
// chat starts at "as set" and sends nothing until picked, so a Plan picked on the desktop stays; the label shows the mode
// the daemon last set (its 'mode' event). A chat made here starts in this phone's last pick for its agent. P6 (row 25):
// all of the agent's modes, the two loosened ones behind the desktop's red warning. Model lists the agent's own models
// from its newest config event.
const provider = (id: string) => String(state.conversations.find((item) => item.id === id)?.provider ?? '');
let picksFor = '';
// A chat made here starts in this phone's last pick for its agent. Kept by ID until its picks are first drawn: a chat
// made while the page's first read runs is a stub, drawn only once its history is in.
const startPick = new Map<string, string>();
function renderPicks(id: string) {
  const configs = state.events.filter((event) => event.conversation === id && event.type === 'config');
  const set = state.events.findLast((event) => event.conversation === id && event.type === 'mode')?.data as { name?: string } | undefined;
  // The agent is in the key: a chat made here can draw before its row is read, with no modes yet.
  const key = id + ':' + provider(id) + ':' + configs.length + ':' + (set?.name ?? '');
  if (key === picksFor) return;
  // The confirmed pick is kept: a redraw while the red warning is open (Codex reports its mode as it starts) must not
  // turn the pick waiting on that warning into the one Cancel goes back to.
  const mode = one<HTMLSelectElement>('#mode'), keep = picksFor.startsWith(id + ':') ? mode.dataset.was ?? '' : startPick.get(id) ?? '';
  picksFor = key;
  mode.innerHTML = `<option value="">Mode: ${escape(set?.name ?? 'as set')}</option>` + ((modes as Record<string, string[]>)[provider(id)] ?? []).map((name) => `<option value="${escape(name)}">Mode: ${escape(name)}</option>`).join('');
  mode.value = keep; mode.dataset.was = mode.value; startPick.delete(id); pill();
  type Pick = { current?: string; options?: { value: string; name: string }[] };
  const config = (configs.at(-1)?.data ?? {}) as { model?: Pick; pickers?: (Pick & { id: string; name: string })[] };
  const model = one<HTMLSelectElement>('#model'), options = config.model?.options ?? [];
  model.hidden = !options.length; model.dataset.current = config.model?.current ?? '';
  model.innerHTML = options.map((o) => `<option value="${escape(o.value)}"${o.value === config.model?.current ? ' selected' : ''}>${escape(o.name)}</option>`).join('');
  // P10: the agent's own effort, fast mode and plan switch (threat model row 22), each sent only when changed.
  one('#pickers').innerHTML = (config.pickers ?? []).map((p) => `<select data-config="${escape(p.id)}" data-current="${escape(p.current)}" aria-label="${escape(p.name)}">${(p.options ?? []).map((o) =>
    `<option value="${escape(o.value)}"${o.value === p.current ? ' selected' : ''}>${escape(p.name + ': ' + o.name)}</option>`).join('')}</select>`).join('');
}
// Keeps the chat live: long-polls the daemon (it holds each request up to 8 s) while the page is visible and online.
async function listen() {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (;;) {
    if (document.hidden || !navigator.onLine) { await pause(2000); continue; }
    const held = state.events.length;
    try {
      await fetchEvents(8000);
      if (state.events.length === held) continue;
      // A chat made, used, stopped or closed anywhere moves in the picker.
      if (state.events.slice(held).some((event) => ['created', 'user', 'stopped', 'closed'].includes(String(event.type)))) { state.conversations = (await request('/chat')).conversations ?? []; fillPicker(); }
      render();
    }
    catch { await pause(3000); }
  }
}
// PH2: the phone keeps its queue. A message typed offline, or while the agent waits on a question or approval (sent then it
// would decline it), is kept here, on this phone, and goes once it can, with `when: 'queue'` so it waits for the turn's
// end. Each goes once: it keeps one operation ID until the daemon answers (mutate), so a lost reply or a reload re-sends
// the same message under the same ID and the daemon replays it. ponytail: this phone's storage only, as the desktop's queue.
type Queued = { qid: string; text: string; mode?: string; model?: string; config?: Record<string, string> };
const queueKey = (id: string) => 'p9-queue:' + id;
function queued(id: string): Queued[] {
  try { const all = JSON.parse(localStorage.getItem(queueKey(id)) ?? '[]'); return Array.isArray(all) ? all.filter((item) => typeof item?.text === 'string' && typeof item.qid === 'string') : []; } catch { return []; }
}
function keepQueue(id: string, items: Queued[]) { if (items.length) localStorage.setItem(queueKey(id), JSON.stringify(items)); else localStorage.removeItem(queueKey(id)); }
// A question or approval still waiting for an answer in this chat.
function asking(id: string) {
  const open = new Set<string>();
  for (const event of state.events) {
    if (event.conversation !== id) continue;
    const kind = String(event.type), request = String((event.data as Json | undefined)?.request);
    if (kind === 'approval' || kind === 'question') open.add(request);
    else if (kind === 'answered') open.delete(request);
    else if (['turn-end', 'interrupted', 'exited', 'stopped'].includes(kind)) open.clear();
  }
  return open.size > 0;
}
// P4: the messages the daemon holds for this chat (Steer or Queue mid-turn), read from its events as the desktop reads
// them: a user event sends the held ones it names. Whether a turn runs is the Chats list's reading (digest), so the top
// bar's "Working…" and the Stop button never disagree.
const running = (id: string) => (digest().get(id)?.run ?? 'idle') !== 'idle';
function turn(id: string) {
  const held = new Map<string, { text: string; when: string }>();
  for (const event of state.events) {
    if (event.conversation !== id) continue;
    const kind = String(event.type), data = (event.data ?? {}) as Json;
    if (kind === 'user') { for (const sent of Array.isArray(data.held) ? data.held : []) held.delete(String(sent)); }
    else if (['interrupted', 'exited', 'stopped', 'error'].includes(kind)) held.clear();
    else if (kind === 'held') held.set(String(data.id), { text: String(data.text), when: String(data.when) });
    else if (kind === 'unheld') held.delete(String(data.id));
  }
  return { held };
}
// The send button, as the desktop's: during a turn an empty box makes it Stop (the text stays yours), and text goes
// in with Steer (after the current step) or, from the Queue button beside it, after the turn.
function label() {
  const id = one<HTMLSelectElement>('#conversation').value, send = one<HTMLButtonElement>('#composer button[type="submit"]');
  const local = !navigator.onLine || asking(id) || queued(id).length > 0, busy = !local && running(id);
  const empty = !one<HTMLTextAreaElement>('#prompt').value.trim() && !(attached.get(id) ?? []).length;
  const box = one<HTMLTextAreaElement>('#prompt');
  if (!restored || box.value) {
    restored = null;
    try { if (box.value.trim()) localStorage.setItem('p9-draft', JSON.stringify({ id, text: box.value })); else localStorage.removeItem('p9-draft'); } catch {}
  }
  box.placeholder = 'Message ' + (provider(id) === 'codex' ? 'Codex' : 'Claude');
  // The box grows with its text from one line to six (phone.css caps it), then scrolls; every change of the text ends
  // here. ponytail: by hand, as iOS Safari has no field-sizing.
  box.style.height = 'auto'; box.style.height = box.scrollHeight + box.offsetHeight - box.clientHeight + 'px';
  send.dataset.stop = String(busy && empty);
  one('#send .vh').textContent = busy ? (empty ? 'Stop' : 'Steer') : local ? 'Queue message' : 'Send message';
  one<HTMLButtonElement>('button[form="composer"][data-when="queue"]').hidden = !busy || empty;
}
function renderQueue() {
  const id = one<HTMLSelectElement>('#conversation').value, items = queued(id), held = [...turn(id).held], box = one<HTMLElement>('#queued');
  box.hidden = !items.length && !held.length;
  box.innerHTML = held.map(([key, item]) => `<article class="event tool"><b>${item.when === 'queue' ? 'Queued' : 'After this step'}</b><p>${escape(item.text)}</p><button type="button" class="quiet" data-unhold="${escape(key)}">Take back</button></article>`).join('')
    + items.map((item) => `<article class="event tool"><b>Queued</b><p>${escape(item.text)}</p><button type="button" class="quiet" data-unqueue="${escape(item.qid)}">Take back</button></article>`).join('');
}
let draining = false;
async function drain() {
  if (draining || !navigator.onLine) return;
  draining = true;
  let sent = false;
  try {
    for (const chat of state.conversations) {
      const id = String(chat.id);
      for (let next = queued(id)[0]; next && !asking(id); next = queued(id)[0]) {
        const { qid, ...body } = next;
        const result = await mutate('/chat/' + encodeURIComponent(id) + '/prompt', { ...body, when: 'queue' });
        // Any answer is final for this message: it went, or the daemon refused it and says why (the text goes back in the box).
        keepQueue(id, queued(id).filter((item) => item.qid !== qid));
        if (result.status === 202) sent = true;
        else {
          const input = one<HTMLTextAreaElement>('#prompt');
          if (id === one<HTMLSelectElement>('#conversation').value) input.value = next.text + (input.value ? '\n' + input.value : '');
          note(`Not sent: ${result.body.error ?? result.status}`);
        }
      }
    }
  } catch { /* a lost request keeps its message and its ID; the next drain sends it again */ }
  finally { draining = false; }
  if (sent) { await fetchEvents(); render(); } else renderQueue();
}
one<HTMLElement>('#queued').onclick = async (event) => {
  const hold = (event.target as Element).closest<HTMLButtonElement>('button[data-unhold]');
  if (hold) {
    // A held one comes back into the box only once the daemon has let it go (it may just have been sent).
    const id = one<HTMLSelectElement>('#conversation').value, item = turn(id).held.get(hold.dataset.unhold!);
    const result = await mutate('/chat/' + encodeURIComponent(id) + '/unhold', { held: hold.dataset.unhold });
    if (result.status === 200 && item) { const input = one<HTMLTextAreaElement>('#prompt'); input.value = item.text + (input.value ? '\n' + input.value : ''); }
    await fetchEvents(); render(); return;
  }
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-unqueue]'); if (!button) return;
  const id = one<HTMLSelectElement>('#conversation').value, item = queued(id).find((entry) => entry.qid === button.dataset.unqueue); if (!item) return;
  keepQueue(id, queued(id).filter((entry) => entry.qid !== item.qid));
  const input = one<HTMLTextAreaElement>('#prompt'); input.value = item.text + (input.value ? '\n' + input.value : '');
  renderQueue(); label();
};
// P4: one tap sends with the keyboard open. The send button never takes focus, so the box keeps it: no blur, no
// keyboard closing and the layout jumping under the finger to eat the tap (focus moves on mousedown, which a tap
// also fires).
for (const button of document.querySelectorAll<HTMLButtonElement>('#composer button[type="submit"], button[form="composer"]')) for (const type of ['pointerdown', 'mousedown']) button.addEventListener(type, (event) => event.preventDefault());
one<HTMLFormElement>('#composer').onsubmit = async (event) => {
  event.preventDefault(); const id = one<HTMLSelectElement>('#conversation').value; const input = one<HTMLTextAreaElement>('#prompt');
  const art = artSending; artSending = null; // item 19: an artifact's comments, sent here as text only; the box and its images stay
  const images = art === null ? attached.get(id) ?? [] : [], submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
  if (id && submitter?.dataset.stop === 'true') {
    // No turn to stop (it just ended): 409 no-turn, and the events say so.
    const result = await mutate('/chat/' + encodeURIComponent(id) + '/cancel', {});
    if (result.status !== 200 && result.body.error !== 'no-turn') note(`Not stopped: ${result.body.error ?? result.status}`);
    await fetchEvents(); render(); return;
  }
  const text = (art ?? input.value).trim();
  if (!id || (!text && !images.length)) return false;
  one<HTMLElement>('#slash').hidden = true;
  const mode = one<HTMLSelectElement>('#mode').value, model = one<HTMLSelectElement>('#model');
  const config = Object.fromEntries([...document.querySelectorAll<HTMLSelectElement>('#pickers select')].filter((pick) => pick.value !== pick.dataset.current).map((pick) => [pick.dataset.config!, pick.value]));
  const body = { text, ...(mode && { mode }), ...(model.value && model.value !== model.dataset.current && { model: model.value }), ...(Object.keys(config).length && { config }) };
  // Behind a queued message it queues too, so they go in the order typed. Images are not queued (up to 8 MB does not
  // fit this phone's storage): they stay attached and the box says why.
  if (!navigator.onLine || asking(id) || queued(id).length) {
    if (images.length) { note('Not sent: images go only with a message sent now. Send again when the agent is free' + (navigator.onLine ? '.' : ' and the phone is online.')); return; }
    keepQueue(id, [...queued(id), { qid: crypto.randomUUID(), ...body }]); if (art === null) input.value = ''; renderQueue(); label(); void drain(); return true;
  }
  const when = running(id) ? (submitter?.dataset.when ?? 'steer') : undefined;
  const result = await mutate('/chat/' + encodeURIComponent(id) + '/prompt', { ...body, ...(when && { when }), ...(images.length && { images: images.map(({ mimeType, data }) => ({ mimeType, data })) }) });
  // A refused send says so; it used to leave the box filled with no sign anything happened.
  if (result.status === 202) { if (art === null) { input.value = ''; attached.delete(id); } label(); note(); renderAttached(); await fetchEvents(); render(); return true; }
  else note(result.body.error === 'updating' ? 'Not sent: P9 is updating and restarts in a moment. Send again in a minute.' : `Not sent: ${result.body.error ?? result.status}`);
};
// Why a message or image did not go, under the box (a line in the chat was wiped by the next redraw); a send clears it.
function note(text = '') { const line = one<HTMLElement>('#composerNote'); line.textContent = text; line.hidden = !text; }
// P8: images attach as on the desktop: the + sheet (Photo library, Take photo, File) or a paste, up to four, checked
// and scaled by the desktop's own readImage; 48 px chips with ✕ above the box. Kept per chat until sent; a reload
// drops them (ponytail: this page's memory only).
function renderAttached() {
  const list = attached.get(one<HTMLSelectElement>('#conversation').value) ?? [], box = one<HTMLElement>('#attached');
  box.hidden = !list.length;
  box.innerHTML = list.map((image, i) => `<span class="chip-img"><img src="data:${escape(image.mimeType)};base64,${escape(image.data)}" alt="${escape(image.name)}"><button type="button" data-unattach="${i}" aria-label="Remove ${escape(image.name)}">✕</button></span>`).join('');
  label();
}
async function addImages(files: Iterable<File>) {
  const id = one<HTMLSelectElement>('#conversation').value; if (!id) return;
  const list = attached.get(id) ?? []; attached.set(id, list);
  note();
  for (const file of files) {
    if (list.length >= MAX_IMAGES) { note('Not attached: four images a message at most.'); break; }
    try { list.push(await readImage(file)); } catch (error) { note(`Not attached: ${file.name}: ${(error as Error)?.message ?? error}.`); }
  }
  renderAttached();
}
one<HTMLElement>('#attached').onclick = (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-unattach]'); if (!button) return;
  attached.get(one<HTMLSelectElement>('#conversation').value)?.splice(Number(button.dataset.unattach), 1); renderAttached();
};
const picker = one<HTMLInputElement>('#attachInput');
const opts = (rows: [string, string, string, boolean?][]) => rows.map(([key, value, text, on]) => `<button type="button" class="opt" data-${key}="${escape(value)}"${on === undefined ? '' : ` role="radio" aria-checked="${on}"`}>${escape(text)}</button>`).join('');
// P4: + and the mode pill open the shared sheet. The phone's own pickers: the photo library, the camera, or its files
// (the same image types the daemon takes); the chooser opens in the same tap, so the browser lets it.
one<HTMLElement>('#attach').onclick = () => openSheet('Attach', opts([['pick', 'library', 'Photo library'], ['pick', 'camera', 'Take photo'], ['pick', 'file', 'File']]));
// The pill reads the mode in use ("Auto ▾"); its sheet lists the modes, then the agent's effort, fast mode and plan
// (the model is the top bar's Model sheet), which live in #modeHome and go back there when the sheet closes (the next sheet's HTML would wipe them).
function pill() {
  const name = (one<HTMLSelectElement>('#mode').selectedOptions[0]?.text ?? '').replace(/^Mode: /, ''), button = one('#modePill');
  button.textContent = (name === 'as set' ? 'Mode' : name) + ' ▾'; button.setAttribute('aria-label', 'Mode: ' + (name || 'as set'));
}
one<HTMLElement>('#modePill').onclick = () => {
  const mode = one<HTMLSelectElement>('#mode');
  // The first row sends no mode: the chat stays in the one it is set to.
  const name = (o: HTMLOptionElement) => o.value ? o.value : 'As set' + (o.text === 'Mode: as set' ? '' : ': ' + o.text.replace(/^Mode: /, ''));
  openSheet('Mode', opts([...mode.options].map((o): [string, string, string, boolean] => ['mode', o.value, name(o), o.value === mode.value])));
  one('#sheetBody').append(one('#more'));
};
sheet.addEventListener('close', () => { if (!one('#modeHome').contains(one('#more'))) one('#modeHome').append(one('#more')); });
one('#sheetBody').addEventListener('click', (event) => {
  const row = (event.target as Element).closest<HTMLButtonElement>('[data-pick], [data-mode]'); if (!row) return;
  sheet.close();
  // A mode goes through the select's change, so a loosened one still asks first (the warning opens as the sheet closes).
  if (row.dataset.mode !== undefined) { const mode = one<HTMLSelectElement>('#mode'); mode.value = row.dataset.mode; mode.dispatchEvent(new Event('change')); return; }
  const pick = row.dataset.pick;
  picker.accept = pick === 'file' ? IMG_OK.join(',') : 'image/*';
  if (pick === 'camera') picker.setAttribute('capture', 'environment'); else picker.removeAttribute('capture');
  picker.click();
});
picker.onchange = () => { void addImages([...picker.files ?? []]); picker.value = ''; };
one<HTMLTextAreaElement>('#prompt').addEventListener('paste', (event) => {
  const files = [...event.clipboardData?.files ?? []]; if (files.length) { event.preventDefault(); void addImages(files); }
});
// A dropped file attaches the same way (spec §4); dropped text still goes into the box.
one<HTMLTextAreaElement>('#prompt').addEventListener('drop', (event) => {
  const files = [...event.dataTransfer?.files ?? []]; if (files.length) { event.preventDefault(); void addImages(files); }
});
// A photo already sent shows in its message, fetched once by hash from the daemon (CP3: only one this chat's messages name).
function sentImgs(id: string, hashes?: string[]) {
  if (!hashes?.length) return '';
  for (const hash of hashes) if (!sentCache.has(hash)) {
    sentCache.set(hash, '');
    request('/chat/' + encodeURIComponent(id) + '/images/' + hash).then((image) => {
      const src = imgSrc({ type: 'image', mimeType: image.mimeType, data: image.data });
      if (src) { sentCache.set(hash, src); render(); }
    }, () => {});
  }
  return `<div class="user-imgs">${hashes.map((hash) => sentCache.get(hash) ? `<img src="${sentCache.get(hash)}" alt="Sent image">` : '').join('')}</div>`;
}
// P10: slash commands, the agent's own list (its newest available_commands_update, this chat's or else the same
// agent's), while the box holds only "/name", as on the desktop. A tap fills one in; the agent runs it.
function showSlash() {
  const input = one<HTMLTextAreaElement>('#prompt'), slash = one<HTMLElement>('#slash'), typed = /^\/(\S*)$/.exec(input.value), id = one<HTMLSelectElement>('#conversation').value;
  const lists = typed ? state.events.filter((event) => (event.data as Json)?.sessionUpdate === 'available_commands_update' && (event.conversation === id || provider(String(event.conversation)) === provider(id))) : [];
  const newest = lists.findLast((event) => event.conversation === id) ?? lists.at(-1), all = ((newest?.data as Json | undefined)?.availableCommands ?? []) as Json[];
  const name = (command: Json) => String(command?.name ?? ''), word = typed?.[1] ?? '';
  const list = [...all.filter((c) => name(c).startsWith(word)), ...all.filter((c) => !name(c).startsWith(word) && name(c).includes(word))].slice(0, 60);
  slash.hidden = !list.length;
  slash.innerHTML = list.map((c) => `<button type="button" class="quiet" data-cmd="${escape(name(c))}"><b>/${escape(name(c))}</b> <small>${escape(c.description)}</small></button>`).join('');
}
one<HTMLTextAreaElement>('#prompt').addEventListener('input', showSlash);
one<HTMLTextAreaElement>('#prompt').addEventListener('input', label);
one<HTMLElement>('#slash').onclick = (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-cmd]'), input = one<HTMLTextAreaElement>('#prompt'); if (!button) return;
  input.value = '/' + button.dataset.cmd + ' '; showSlash(); input.focus();
};
one<HTMLSelectElement>('#conversation').onchange = render; // a stub's history loads from render
// P10: a question's Answer and Decline, the same POST /chat/:id/answer.
async function answerQuestion(form: HTMLFormElement, decline: boolean) {
  const id = one<HTMLSelectElement>('#conversation').value, request = form.dataset.question!;
  const asked = state.events.find((event) => event.type === 'question' && (event.data as Json)?.request === request)?.data as Json | undefined;
  const fields = (asked?.form as Json | null)?.fields as Json[] | undefined;
  if (!decline && !fields) return;
  form.querySelectorAll('button').forEach((item) => { item.disabled = true; });
  const result = await mutate('/chat/' + encodeURIComponent(id) + '/answer', { request, answer: decline ? { action: 'decline' } : { action: 'accept', content: questionAnswer(form, fields!) } });
  if (result.status === 200) { await fetchEvents(); render(); }
  else { form.querySelectorAll('button').forEach((item) => { item.disabled = false; }); one('#events').insertAdjacentHTML('beforeend', `<div class="empty">Not answered: ${escape(result.body.error ?? result.status)}</div>`); }
}
one<HTMLElement>('#events').addEventListener('submit', (event) => { event.preventDefault(); void answerQuestion(event.target as HTMLFormElement, false); });
// Phase 17 row 2: an approval answered from the phone, the same POST /chat/:id/answer the desktop uses.
one<HTMLElement>('#events').onclick = async (event) => {
  const decline = (event.target as Element).closest<HTMLButtonElement>('button[data-decline]');
  if (decline) return answerQuestion(decline.form!, true);
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-request]'); if (!button) return;
  const id = one<HTMLSelectElement>('#conversation').value;
  button.parentElement!.querySelectorAll('button').forEach((item) => { item.disabled = true; });
  const result = await mutate('/chat/' + encodeURIComponent(id) + '/answer', { request: button.dataset.request, answer: { optionId: button.dataset.option } });
  if (result.status === 200) { await fetchEvents(); render(); }
  else { button.parentElement!.querySelectorAll('button').forEach((item) => { item.disabled = false; }); one('#events').insertAdjacentHTML('beforeend', `<div class="empty">Not answered: ${escape(result.body.error ?? result.status)}</div>`); }
};
// P6: Bypass permissions and Full access ask first, in the desktop's words; Cancel puts the pick back. "Don't show again"
// is kept per mode on this phone, as the desktop keeps it on its computer.
const loose = one<HTMLDialogElement>('#looseDlg');
// Chromium fires the dialog's close a frame later, so the last warning's close can land after the next one opened:
// it answers only a warning that is closed, and opening a new one settles the old one as Cancel.
let answer: ((value: string) => void) | undefined;
loose.addEventListener('close', () => { if (!loose.open) { answer?.(loose.returnValue); answer = undefined; } });
one<HTMLSelectElement>('#mode').onchange = async (event) => {
  const mode = event.target as HTMLSelectElement, pick = mode.value, agent = provider(one<HTMLSelectElement>('#conversation').value);
  if (pick in LOOSE && !localStorage.getItem('p9-mode-ok:' + pick)) {
    one('#looseT').textContent = `Turn on ${pick} for ${agent === 'codex' ? 'Codex' : 'Claude'}?`; one('#looseP').textContent = (LOOSE as Record<string, string>)[pick];
    answer?.('no');
    const value = await new Promise<string>((done) => { answer = done; loose.returnValue = ''; loose.showModal(); });
    if (value === 'never') localStorage.setItem('p9-mode-ok:' + pick, '1');
    else if (value !== 'yes') { mode.value = mode.dataset.was ?? ''; pill(); return; }
  }
  mode.value = mode.dataset.was = pick; pill();
  if (pick && agent) localStorage.setItem('p9-mode:' + agent, pick);
};
// Phase 17 rows 4-5: the phone's terminal; terminal.mjs holds the part the desktop dock shares (leases, size, output).
const KEYS: Record<string, string> = { esc: '\x1b', tab: '\t', ctrlc: '\x03', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };
const term = createTerminal({ screen: one('#screen'), connect: (id: string) => new WebSocket(location.origin.replace(/^http/, 'ws') + '/terminals/' + encodeURIComponent(id) + '/socket'),
  state(text: string, live: boolean) {
    one('#termState').textContent = text;
    document.querySelectorAll<HTMLButtonElement>('#keys button').forEach((button) => { button.disabled = !live; });
  } });
const termState = term.show;
function attach() {
  const picked = one<HTMLSelectElement>('#terminal'), id = picked.value;
  // Spec §6: "Terminal · 11:39" in the bar (the full date was cut at 390 wide); the sheet keeps the date.
  one('#termTitle').textContent = id ? picked.selectedOptions[0].dataset.short! : 'Terminal';
  if (!id) { term.close(); return termState('No terminal open'); }
  if (!navigator.onLine) { term.close(); return termState('Offline: terminal closed'); }
  term.attach(id);
}
async function loadTerminals() {
  try {
    const list = ((await request('/terminals')).terminals ?? []) as Json[];
    const select = one<HTMLSelectElement>('#terminal'), was = select.value;
    const running = list.filter((item) => item.state === 'running').reverse();
    // The bar's title: 24-hour today ("Terminal · 14:35"; with AM/PM it is cut at 390 wide), the date before.
    const short = (ms: unknown) => new Date(Number(ms)).toDateString() === new Date().toDateString() ? new Date(Number(ms)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : clock(ms);
    select.innerHTML = running.map((item) => `<option value="${escape(item.id)}" data-short="${escape('Terminal · ' + short(item.created))}">${escape('Terminal · ' + when(item.created))}</option>`).join('') || '<option value="">No terminals yet</option>';
    if (running.some((item) => item.id === was)) select.value = was;
    attach();
  } catch (error) {
    const { message, body } = error as Error & { body?: Json };
    termState(message === 'tmux-not-found' ? TMUX_MISSING : message === 'terminal-unavailable' ? unavailableText(body?.reason) : 'Terminals are unavailable');
  }
}
one<HTMLSelectElement>('#terminal').onchange = attach;
one<HTMLElement>('#pickTerminal').onclick = () => {
  const select = one<HTMLSelectElement>('#terminal'), options = [...select.options].filter((option) => option.value);
  if (options.length) openSheet('Terminals', options.map((option) => `<button type="button" class="opt" role="menuitemradio" aria-checked="${option.value === select.value}" data-term="${escape(option.value)}">${escape(option.textContent)}</button>`).join(''));
};
one<HTMLButtonElement>('#refreshTerminal').onclick = () => void loadTerminals();
one<HTMLButtonElement>('#newTerminal').onclick = async () => {
  const result = await mutate('/terminals', {});
  if (result.status !== 201) return termState(result.body.error === 'tmux-not-found' ? TMUX_MISSING
    : result.body.error === 'terminal-unavailable' ? unavailableText(result.body.reason) : 'Not started: ' + String(result.body.error ?? result.status));
  await openTerminal(String(result.body.terminal));
};
// A terminal the daemon just made (New terminal, Sprint's Open tmux): the picker reloads and attaches to it.
async function openTerminal(id: string) {
  one<HTMLSelectElement>('#terminal').value = ''; await loadTerminals();
  one<HTMLSelectElement>('#terminal').value = id; attach();
}
one<HTMLButtonElement>('#stopTerminal').onclick = async () => {
  const id = one<HTMLSelectElement>('#terminal').value; if (!id) return;
  const result = await mutate('/terminals/' + encodeURIComponent(id) + '/stop', {});
  if (result.status !== 200) return termState('Stop failed: ' + String(result.body.error ?? result.body.result ?? result.status));
  await loadTerminals();
};
document.querySelectorAll<HTMLButtonElement>('#keys button:not([data-key="paste"])').forEach((button) => { button.onclick = () => { term.sendKeys(KEYS[button.dataset.key!]); term.focus(); }; });
// T2: Paste reads the clipboard on this tap only (threat model row 19) and sends it under the tap's lease. The browser
// may ask first; past 4 s the daemon could drop it as late (5 s lease), so the page asks for another tap instead.
one<HTMLButtonElement>('[data-key="paste"]').onclick = async (event) => {
  const at = event.timeStamp;
  let text: string;
  try { text = await navigator.clipboard.readText(); } catch { return termState('Paste not allowed: the browser did not share the clipboard', term.open); }
  if (performance.now() - at > 4000) return termState('Paste took too long: tap Paste again', term.open);
  if (text) term.paste(text, at);
  term.focus();
};
// T2: a tap on the terminal opens the keyboard. A finger's touchend on xterm's screen never becomes a click (the click this
// line used to wait for did not come), so a tap is read from the touch itself: lifted within 10 px and 600 ms of going down.
// Focus has to happen inside that event for a phone to raise its keyboard. The click stays for a mouse.
one('#screen').addEventListener('click', () => term.focus());
let tapFrom: { x: number; y: number; at: number } | null = null;
one('#screen').addEventListener('touchstart', (event) => { const touch = (event as TouchEvent).touches[0]; tapFrom = (event as TouchEvent).touches.length === 1 ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp } : null; }, { passive: true });
one('#screen').addEventListener('touchend', (event) => {
  const touch = (event as TouchEvent).changedTouches[0];
  if (tapFrom && Math.hypot(touch.clientX - tapFrom.x, touch.clientY - tapFrom.y) < 10 && event.timeStamp - tapFrom.at < 600) term.focus();
  tapFrom = null;
}, { passive: true });
addEventListener('resize', term.fit); window.visualViewport?.addEventListener('resize', term.fit); // the screen fills the column, which follows a keyboard
addEventListener('offline', () => { if (term.close()) termState('Offline: terminal closed'); });
termState('No terminal open');
// P9: a tap on an agent's image opens it full screen; any tap closes it.
const picture = document.body.appendChild(Object.assign(document.createElement('dialog'), { className: 'picture', onclick: () => picture.close() }));
addEventListener('click', (event) => {
  const image = (event.target as Element).closest?.('.agent-imgs img, .user-imgs img') as HTMLImageElement | null; if (!image) return;
  picture.replaceChildren(Object.assign(document.createElement('img'), { src: image.src, alt: image.alt })); picture.showModal();
});
one<HTMLElement>('#gap').onclick = () => { one<HTMLElement>('#gap').hidden = true; void loadChat(); };

// Mission: the same daemon routes the desktop uses. Native <details> rows open in place; scripts stream output from
// /runs/:id. Terminal scripts and laptop apps open windows on the laptop, so the phone lists them as laptop-only.
type Item = { id: string; title: string; desc: string; group: string; args: string[]; confirm: boolean; terminal: boolean; url: string };
type Waiting = { name: string; title: string; project: string; age: string; hash: string; content: string; answerable: boolean };
type Hub = { notices: { kind: string; text: string }[] | null; incidents: { host: string; check: string; name: string; resolved: boolean; count: number; failed: string[] }[];
  inbox: { branch: string; decision: string; pages: string[] }[]; logs: { host: string; name: string; age_min: number; last: string }[]; handoffs: { project: string; age_days: number }[];
  audit: { run?: string; review?: string; ticked?: number; changes?: number; contradiction_count?: number | null }; solo: { name: string; bluf: string }; ideas: number; needs_done: number };
let mission: { queue: Waiting[]; scripts: Item[] } = { queue: [], scripts: [] };
const row = (summary: string, body: string) => `<details class="row"><summary>${summary}</summary><div class="body">${body}</div></details>`;
// Each section is a small tile that opens it as a full-screen window (Builder, 2026-10-17: "group everything so that
// its in a window i can open"). Callers escape title and line.
const win = (id: string, title: string, count: number | string, line: string, body: string, bad = false) => {
  // Rows needing attention (a red one, or something waiting) lead the list; a zero count is drawn muted (spec §6).
  const attn = bad || (id === 'queue' && Number(count) > 0), zero = /^(0( .*)?)?$/.test(String(count));
  return `<button type="button" class="tile${bad ? ' bad' : ''}"${attn ? ' data-attn' : ''}${zero ? ' data-zero' : ''} data-open="${id}"><span>${title}</span><b>${count}</b><small>${line}</small></button>`
    + `<dialog class="window" id="w-${id}"><header class="bar"><button type="button" class="back" data-close aria-label="Back to Mission">${ICON.back}Mission</button><div class="title"><h1>${title}</h1></div></header><div class="wbody">${body}</div></dialog>`;
};
// A reload rebuilds the tiles (loadMission empties #hub until loadHub refills it); the window Builder had open opens
// again, with the rows he had expanded (matched by the summary's title, not its <small>, which can change; reopening
// fires toggle, which reloads lazy text).
// Kept across renders: loadMission empties #hub, so the hub window is missing when loadHub renders it again.
let openWindow = '', expanded = new Set<string | null | undefined>();
function keepOpen(render: () => void) {
  const rows = (dialog: HTMLElement | null) => [...dialog?.querySelectorAll<HTMLDetailsElement>('details.row') ?? []];
  const title = (d: HTMLDetailsElement) => d.querySelector('summary')!.firstChild?.textContent;
  const windowNow = () => openWindow ? document.getElementById('w-' + openWindow) : null;
  if (windowNow()) expanded = new Set(rows(windowNow()).filter((d) => d.open).map(title));
  holdTyped(); render(); putTyped();
  const again = windowNow() as HTMLDialogElement | null;
  if (again && !again.open) again.showModal();
  rows(again).forEach((d) => { if (!d.open && expanded.has(title(d))) d.open = true; });
}
// T7: the last Mission and hub answers are kept here and in localStorage (threat model row 56; a 401 forgets them). A tap
// on Mission draws them at once, then both routes refresh behind; before, the page waited on GET /mission, then emptied
// #hub and waited on GET /mission/hub.
const kept = (key: string) => { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } };
const keep = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }; // storage full: no cache
// P2: Mission text typed and not sent. A redraw (Refresh, the hub's retry, a save) rebuilds the forms, so keepOpen() reads
// it before and puts it back after; toLogin() keeps the same record through a sign-in. An answer is matched by its item's
// name (its place in the list can change); a sent answer or a saved idea leaves the record.
type MissionDraft = { answers: Record<string, string>; idea: { name: string; text: string; needs: boolean } | null };
const typed: MissionDraft = { answers: {}, idea: null };
const answerForms = () => [...document.querySelectorAll<HTMLFormElement>('#mission form[data-answer]')].map((form) => ({ form, name: mission.queue[Number(form.dataset.answer)]?.name, box: form.querySelector('textarea')! }));
const ideaField = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;
function holdTyped() {
  for (const { name, box } of answerForms()) if (name) { if (box.value.trim()) typed.answers[name] = box.value; else delete typed.answers[name]; }
  const form = document.querySelector<HTMLFormElement>('#mission form[data-idea]');
  if (form) typed.idea = ideaField(form, 'name').value.trim() || ideaField(form, 'text').value.trim()
    ? { name: ideaField(form, 'name').value, text: ideaField(form, 'text').value, needs: ideaField(form, 'needs').checked } : null;
}
function putTyped() { // the row holding text put back opens, so the text is in sight
  const opened = (form: HTMLFormElement) => { const row = form.closest('details'); if (row) row.open = true; };
  for (const { form, name, box } of answerForms()) if (name && typed.answers[name] && !box.value) { box.value = typed.answers[name]; opened(form); }
  const form = document.querySelector<HTMLFormElement>('#mission form[data-idea]');
  if (form && typed.idea && !ideaField(form, 'name').value && !ideaField(form, 'text').value) {
    ideaField(form, 'name').value = typed.idea.name; ideaField(form, 'text').value = typed.idea.text; ideaField(form, 'needs').checked = typed.idea.needs; opened(form);
  }
}
function keptMission(part: 'answers' | 'idea') {
  const draft = kept('p9-mission-draft');
  if (!draft || typeof draft !== 'object') return;
  const shown = (form: HTMLFormElement) => {
    form.querySelector<HTMLElement>('[data-note]')!.textContent = 'Kept through sign-in, not sent';
    const dialog = form.closest('dialog') as HTMLDialogElement, row = form.closest('details');
    if (row) { row.open = true; expanded.add(row.querySelector('summary')!.firstChild?.textContent); }
    openWindow = dialog.id.slice(2); if (!dialog.open) dialog.showModal();
  };
  if (part === 'answers') {
    const answers: Record<string, unknown> = draft.answers && typeof draft.answers === 'object' ? draft.answers : {};
    document.querySelectorAll<HTMLFormElement>('#mission form[data-answer]').forEach((form) => {
      const name = mission.queue[Number(form.dataset.answer)]?.name ?? '', text = answers[name];
      if (typeof text === 'string') { form.querySelector('textarea')!.value = text; delete answers[name]; shown(form); }
    });
    // An item answered or removed elsewhere meanwhile has no box: its text is shown to copy, not dropped.
    const left = Object.entries(answers).filter(([, text]) => typeof text === 'string');
    const queue = document.querySelector<HTMLDialogElement>('#w-queue');
    if (left.length && queue) {
      queue.querySelector('.wbody')!.insertAdjacentHTML('afterbegin', '<article class="card" data-kept><h2>Kept from before sign-in</h2><p class="muted">Answered or removed elsewhere since; copy your text if you still need it.</p>'
        + left.map(([name, text]) => `<p><b>${escape(name)}</b></p><pre>${escape(String(text))}</pre>`).join('') + '</article>');
      openWindow = 'queue'; if (!queue.open) queue.showModal();
    }
    draft.answers = {};
  } else {
    const form = document.querySelector<HTMLFormElement>('#mission form[data-idea]'), idea = draft.idea;
    if (!form || !idea || typeof idea.name !== 'string' || typeof idea.text !== 'string') return;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    field('name').value = idea.name; field('text').value = idea.text; field('needs').checked = idea.needs === true;
    shown(form); draft.idea = null;
  }
  try { if (draft.idea) localStorage.setItem('p9-mission-draft', JSON.stringify(draft)); else localStorage.removeItem('p9-mission-draft'); } catch {}
}
const forgetMission = () => { try { localStorage.removeItem('p9-mission'); localStorage.removeItem('p9-mission-hub'); } catch {} };
let lastMission: any = kept('p9-mission'), lastHub: Hub | null = kept('p9-mission-hub'), missionDrawn = false;
async function loadMission(cached = false) {
  try {
    const data = cached ? lastMission : await request('/mission');
    mission = data;
    const queue = (data.queue as Waiting[]).map((item, index) => row(`${escape(item.title)}<small>${escape(item.project)} · ${escape(item.age)}</small>`,
      `<pre>${escape(item.content)}</pre>` + (item.answerable
        ? `<form data-answer="${index}"><label>Your answer<textarea rows="3" required maxlength="4000"></textarea></label><button type="submit">Send answer</button><p class="muted" data-note></p></form>`
        : '<p class="muted">Open this one on the desktop: it has no empty answer line.</p>'))).join('');
    const groups = new Map<string, string[]>(), names = new Map<string, string[]>(); // a section's rows, and their titles for its detail line
    (data.scripts as Item[]).forEach((item, index) => {
      const inputs = (item.args as unknown as (string | { label: string; choices?: string[] })[]).map((arg) => typeof arg === 'string'
        ? `<label>${escape(arg)}<input maxlength="8000" autocomplete="off" /></label>`
        : `<label>${escape(arg.label)}<select><option value="">(none)</option>${(arg.choices ?? []).map((choice) => `<option>${escape(choice)}</option>`).join('')}</select></label>`).join('');
      const body = `${item.desc ? `<p>${escape(item.desc)}</p>` : ''}` + (item.terminal
        ? '<p class="muted">Laptop only: this script opens a terminal window.</p>'
        : `<form data-run="${index}">${inputs}${inputs ? `<button type="submit">${item.confirm ? 'Run (asks first)' : 'Run'}</button>` : ''}</form><pre data-output hidden></pre><button type="button" data-copy hidden>Copy</button>`);
      // Spec §6: the closed row has a Run pill at its right. A script with fields keeps its Run button by them; the pill opens the row there.
      const pill = item.terminal ? '' : `<button type="button" class="pill" data-run-now>${item.confirm ? 'Run…' : 'Run'}</button>`;
      groups.set(item.group || 'Scripts', [...(groups.get(item.group || 'Scripts') ?? []), row(escape(item.title) + pill, body)]);
      names.set(item.group || 'Scripts', [...(names.get(item.group || 'Scripts') ?? []), item.title]);
    });
    // The free-form space: a section's buttons arrived with the scripts above; its text and log views join the same group.
    const notes = new Map<string, string>();
    for (const space of (data.space ?? []) as { title: string; text: string; logs: { id: string; title: string }[]; notes?: string }[]) {
      if (space.text) notes.set(space.title, `<p class="muted" data-space-text>${escape(space.text)}</p>`);
      // Notes (threat model row 34): the list loads when the row opens; a note opens in the file editor below.
      const folder = space.notes ? [row(`Notes<small>${escape(space.notes)}</small>`, `<div data-notes="${escape(space.notes)}"><p class="muted">Loading…</p></div>`)] : [];
      groups.set(space.title, [...(groups.get(space.title) ?? []), ...folder, ...space.logs.map((log) => row(escape(log.title), lazy({ kind: 'space', name: log.id })))]);
      names.set(space.title, [...(names.get(space.title) ?? []), ...(space.notes ? ['Notes'] : []), ...space.logs.map((log) => log.title)]);
    }
    const links = [...data.pages, ...data.apps.filter((item: Item) => item.url)].map((item: Item) => (/^https?:\/\//i.test(item.url)
      ? `<li><a class="link" href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">${escape(item.title)}</a></li>`
      // M6: another program's link opens on the laptop only after the full link was shown and confirmed.
      : `<li><button type="button" class="link" data-open-page="${escape(item.id)}" data-url="${escape(item.url)}">${escape(item.title)} (opens on the laptop)</button></li>`)).join('');
    const laptopApps = data.apps.filter((item: Item) => !item.url).length;
    const status = escape(String(data.primary?.status ?? '').replace(/\*\*/g, ''));
    // Item 14: a laptop is updating this server's P9; it restarts once no chat is mid-turn (apps/server/update.mjs).
    keepOpen(() => { one('#mission').innerHTML = (data.update ? `<article class="card warn" data-update><h2>P9 is updating to ${escape(data.update.version)}</h2><p>${data.update.phase === 'waiting-turns' ? `It restarts when ${data.update.turns} chat${data.update.turns === 1 ? ' finishes its' : 's finish their'} turn. New messages wait until it is back.` : data.update.phase === 'restarting' ? 'It is restarting now; this page reconnects by itself.' : 'Building the new version beside the running one. Chats keep working.'}</p></article>` : '') + (data.restart?.needed ?`<article class="card warn"><h2>Restart P9 to apply</h2><p>The workspace folder ${escape(data.restart.folder)} was not there when P9 started, so it is using the default folder. Restart P9 on the computer.</p></article>` : '') + (data.settingsError ? `<article class="card warn"><h2>Settings</h2><p>settings.json has a problem, so the last good settings are in use: ${escape(data.settingsError)}</p></article>` : '') + (data.invalid.length ? `<article class="card warn"><h2>Registry</h2><p>${data.invalid.length} entries are malformed and hidden.</p></article>` : '')
      + '<div class="tiles"><h2 class="grp a">Needs attention</h2><h2 class="grp b">Everything else</h2>'
      + win('queue', 'Waiting on you', data.queue.length, data.queue[0] ? escape(data.queue[0].title) : 'Nothing is waiting on you.', queue || '<div class="empty">Nothing is waiting on you.</div>')
      + win('primary', 'Main project', escape(data.primary?.name ?? 'None'), status, `<article class="card"><h2>${escape(data.primary?.name ?? 'No primary project')}</h2><small>${status}</small></article>`)
      + '<div id="hub"></div><div id="sprint"></div>'
      + [...groups].map(([group, rows], index) => win('g' + index, escape(group), rows.length, escape((names.get(group) ?? []).join(' · ')),(notes.get(group) ?? '') + rows.join(''))).join('')
      + win('pages', 'Pages', data.pages.length, escape(data.pages.map((item: Item) => item.title).join(' · ')) || 'No pages.',`<ul class="list">${links}</ul>` + (laptopApps ? `<p class="muted">${laptopApps} laptop apps open from the desktop.</p>` : ''))
      + '</div>'; });
    missionDrawn = true;
    if (!cached) { lastMission = data; keep('p9-mission', data); keptMission('answers'); }
  } catch { if (cached) lastMission = null; else if (!missionDrawn) one('#mission').innerHTML = '<div class="empty">Mission Control is unavailable.</div>'; return; }
  if (lastHub) void loadHub(true); // the redraw above emptied #hub: refill it from memory, not from the wire
  if (!cached) void loadHub();
  if (!cached) void loadSprint();
}
// Sprint tracker: a tile while the computer has a sprint status file (404 = none, so no tile); one ring per chunk, the
// sprint scripts (registry ids sprint-start, sprint-close, sprint-heavy; they ask first like any script) and Open tmux.
type Sprint = { sprint: string; updatedAt: string; cutoff: string; overall?: number; chunks: { id: string; title: string; state: string; percent: number; waitingOn: string; steps?: string; activity?: string }[] };
const SPRINT_SCRIPTS = [['sprint-start', 'Sprint start'], ['sprint-close', 'Sprint close'], ['sprint-heavy', 'Heavy services']];
async function loadSprint() {
  const target = document.querySelector<HTMLElement>('#sprint');
  if (!target) return;
  let data: Sprint | null = null, error = '';
  try { data = await request('/mission/sprint'); } catch (failed) {
    const body = (failed as { body?: { error?: string; reason?: string } }).body;
    if (!body || body.error === 'no-sprint' || body.error === 'settings-missing') { target.innerHTML = ''; return; }
    error = body.reason ?? body.error ?? 'unreadable';
  }
  const rings = data ? data.chunks.map((c) => `<div class="spr" data-state="${escape(['running', 'waiting', 'merged', 'blocked'].includes(c.state) ? c.state : 'unknown')}"><div class="ring" role="img" aria-label="${escape(c.id)} ${escape(c.state)} ${c.percent}%" style="--p:${Number(c.percent)}"><b>${Number(c.percent)}%</b></div>`
    + `<div class="spt"><b>${escape(c.id)} · ${escape(c.title)}</b><small class="st">${escape(c.state)}${c.activity ? ` · <span data-activity="${escape(c.activity)}">${escape(c.activity)}</span>` : ''}${c.steps ? ` · <span data-steps>${escape(c.steps)}</span>` : ''}</small>${c.waitingOn && (c.state === 'waiting' || c.state === 'blocked') ? `<small class="muted">Waiting on: ${escape(c.waitingOn)}</small>` : ''}</div></div>`).join('') || '<div class="empty">No chunks in the status file yet.</div>' : '';
  const overall = data && Number.isFinite(data.overall) ? `<div class="spall"><div class="ring" role="img" aria-label="Whole sprint ${Number(data.overall)}%" style="--p:${Number(data.overall)}" data-overall><b>${Number(data.overall)}%</b></div><div class="spt"><b>Whole sprint</b><small class="muted">${data.chunks.filter((c) => c.state === 'merged').length} of ${data.chunks.length} merged</small></div></div>` : '';
  const scripts = SPRINT_SCRIPTS.map(([id, label]) => { const index = mission.scripts.findIndex((item) => item.id === id);
    return index < 0 ? `<p class="muted">${label}: add a ${id} button to the registry.</p>` : `<form data-run="${index}"><button type="submit">${label} (asks first)</button></form><pre data-output hidden></pre><button type="button" data-copy hidden>Copy</button>`; }).join('');
  const merged = data ? data.chunks.filter((c) => c.state === 'merged').length : 0;
  keepOpen(() => { target.innerHTML = win('sprint', data ? 'Sprint · ' + escape(data.sprint || 'unnamed') : 'Sprint', data ? `${merged}/${data.chunks.length}` : '!',
    data ? `merged · updated ${escape(data.updatedAt || 'unknown')}` : 'status file unreadable',
    (data ? `${overall}<p class="muted" data-sprint-times>${escape(sprintTimes(data))}</p><div class="springs">${rings}</div>`
      : `<article class="card warn"><p>The sprint status file is there but P9 cannot read it (${escape(error)}).</p></article>`)
    + `<div class="sprint-acts">${scripts}<button type="button" class="quiet" data-sprint-tmux>Open tmux</button><p class="muted" data-tmux-note></p></div>`, !data); });
}
one('#mission').addEventListener('click', async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-sprint-tmux]');
  if (!button) return;
  const result = await mutate('/mission/sprint/tmux', {});
  if (result.status !== 201) { button.parentElement!.querySelector<HTMLElement>('[data-tmux-note]')!.textContent = 'Not opened: ' + String(result.body.error ?? result.status); return; }
  button.closest('dialog')?.close();
  show('terminal'); await openTerminal(String(result.body.terminal));
});
// The old workspace-hub sections. Each row's text loads when it is opened.
const ago = (min: number) => min < 60 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
const lazy = (query: Record<string, string>) => `<pre data-text="${escape(new URLSearchParams(query).toString())}">Loading…</pre>`;
async function loadHub(cached = false) {
  const target = document.querySelector<HTMLElement>('#hub');
  if (!target) return;
  let o: Hub;
  // No hub folder in settings (an answer, not a lost connection): these sections stay hidden, cached or not.
  try { o = cached ? lastHub! : await request('/mission/hub'); } catch (error) { if ((error as { body?: unknown }).body) { lastHub = null; target.innerHTML = ''; try { localStorage.removeItem('p9-mission-hub'); } catch {} } return; }
  if (!cached) { lastHub = o; keep('p9-mission-hub', o); }
  const notices = o.notices === null ? '<div class="empty">Checking scheduled jobs and setup…</div>'
    : o.notices.map((n) => `<article class="card warn"><h2>${n.kind === 'job' ? 'SILENT JOB' : 'SETUP'}</h2><p>${escape(n.text)}</p></article>`).join('') || '<div class="empty">Every scheduled job reported in.</div>';
  const open = o.incidents.filter((i) => !i.resolved);
  const incidents = o.incidents.map((i) => row(`${i.resolved ? '' : '⚠ '}${escape(i.check)}<small>${escape(i.host)} · failed ${i.count}×, last ${escape(i.failed[0])}${i.resolved ? ' · resolved' : ''}</small>`, lazy({ kind: 'incident', host: i.host, name: i.name }))).join('');
  const inbox = o.inbox.map((b) => row(`${escape(b.branch)}<small>${escape(b.decision)} · ${b.pages.length} page${b.pages.length === 1 ? '' : 's'}</small>`,
    lazy({ kind: 'inbox', name: b.branch }) + `<form data-decide="${escape(b.branch)}"><button type="submit" value="merge">Approve</button> <button type="submit" value="reject">Reject</button><p class="muted" data-note></p></form>`)).join('');
  const logs = o.logs.map((l) => row(`${escape(l.name)}<small>${escape(l.host)} · ${ago(l.age_min)} · ${escape(l.last)}</small>`, lazy({ kind: 'log', host: l.host, name: l.name }))).join('');
  const handoffs = o.handoffs.sort((a, b) => a.age_days - b.age_days).map((h) => row(`${escape(h.project)}<small>updated ${h.age_days} d ago</small>`, lazy({ kind: 'handoff', name: h.project }))).join('');
  const audit = o.audit.run ? `<p>Weekly audit ${escape(o.audit.run)} (${escape(o.audit.review)}): ${o.audit.ticked} of ${o.audit.changes} ticked, ${o.audit.contradiction_count ?? 0} contradictions.</p>` : '';
  const solo = escape(o.solo.name.replace(/-solo-run-report\.md$/, ''));
  keepOpen(() => { target.innerHTML = win('notes', 'Notifications', o.notices ? o.notices.length : '…', o.notices?.[0] ? escape(o.notices[0].text) : o.notices ? 'Every scheduled job reported in.' : 'Checking…', notices, !!o.notices?.length)
    + win('incidents', 'Incidents', `${open.length} open`, open[0] ? escape(open[0].host + ' · ' + open[0].check) : 'No open incidents.', incidents || '<div class="empty">No incidents.</div>', open.length > 0)
    + win('inbox', 'Wiki review inbox', o.inbox.length, o.inbox.length ? 'batches to review' : 'Nothing to review.', inbox || '<div class="empty">No Wiki batches waiting for review.</div>')
    + win('handoffs', 'Work in flight', o.handoffs.length, o.handoffs[0] ? 'newest: ' + escape(o.handoffs[0].project) : 'No HANDOFF.md files.', handoffs)
    + win('solo', 'Last solo run', solo, escape(o.solo.bluf || ''), row(`${solo}<small>${escape(o.solo.bluf || '')}</small>`, lazy({ kind: 'solo' })))
    + win('work', 'Workspace', o.ideas, `ideas · ${o.needs_done} punch-list · + New idea`, `<article class="card"><h2>Workspace</h2><p>${o.ideas} ideas not researched · ${o.needs_done} punch-list items</p>${audit}</article>`
    + row('+ New idea', '<form data-idea><p class="muted">Saved to _ideas/, or _ideas/needs-done/ for a fix to something that already exists.</p><input name="name" placeholder="short-name" required><textarea name="text" rows="6"></textarea><label><input type="checkbox" name="needs"> A fix for an existing project (needs-done)</label><button type="submit">Save idea</button><p class="muted" data-note></p></form>'))
    + win('logs', 'Logs', o.logs.length, o.logs[0] ? escape(o.logs[0].name) : 'No logs.', logs); });
  if (!cached) keptMission('idea');
  if (o.notices === null && !cached) setTimeout(() => void loadHub(), 15000);
}
one('#mission').addEventListener('click', (event) => {
  const target = event.target as Element;
  const open = target.closest<HTMLElement>('[data-open]');
  // A Run pill runs a script with no fields at once and opens one with fields at its first field; the row opens either way, for the output.
  const now = target.closest<HTMLElement>('[data-run-now]');
  if (now) {
    const details = now.closest('details')!, form = details.querySelector<HTMLFormElement>('form[data-run]')!, field = form.querySelector<HTMLElement>('input, select');
    details.open = true;
    if (field) field.focus(); else form.requestSubmit();
  }
  else if (open) { openWindow = open.dataset.open!; (document.getElementById('w-' + openWindow) as HTMLDialogElement).showModal(); }
  else if (target.closest('[data-close]')) target.closest('dialog')!.close();
});
// Close button or Escape; a dialog removed by a reload is outside #mission by then, so it never clears this.
one('#mission').addEventListener('close', () => { openWindow = ''; expanded = new Set(); }, true);
one('#mission').addEventListener('toggle', async (event) => {
  const list = (event.target as HTMLElement).querySelector<HTMLElement>(':scope > .body > div[data-notes]');
  if (list && !list.dataset.loaded) {
    list.dataset.loaded = '1';
    const root = list.dataset.notes!;
    try {
      const { files, total, partial } = await request('/mission/notes?' + new URLSearchParams({ root })) as { files: { path: string; modified: number }[]; total: number; partial: boolean };
      list.innerHTML = `<p class="muted">${files.length < total ? `Showing the newest ${files.length} of ${total} notes` : `${total} notes`}${partial ? ' · a very big folder: some subfolders were not read' : ''}</p>`
        + `<ul class="list">${files.map((f) => `<li><button type="button" class="quiet" data-note-root="${escape(root)}" data-note="${escape(f.path)}">${escape(f.path)} <small class="muted">${ago(Math.max(0, Math.round((Date.now() - f.modified) / 60000)))} ago</small></button></li>`).join('')}</ul>`;
    } catch (error) { list.innerHTML = `<p class="muted">Could not list the notes (${escape((error as Error).message)})</p>`; }
  }
  const pre = (event.target as HTMLElement).querySelector<HTMLElement>(':scope > .body > pre[data-text]');
  if (!pre || pre.dataset.loaded) return;
  pre.dataset.loaded = '1';
  try { pre.textContent = (await request('/mission/hub/text?' + pre.dataset.text)).text; } catch (error) { pre.textContent = `Could not read it (${(error as Error).message})`; }
}, true);
async function follow(run: string, output: HTMLElement) {
  let from = 0;
  for (;;) {
    const part = await request(`/runs/${encodeURIComponent(run)}?from=${from}`);
    output.textContent += part.output; from = part.next;
    if (part.done) { output.textContent += part.code === 0 ? '' : `\n[exit ${part.code}]`; return; }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}
one('#mission').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  if (form.dataset.run !== undefined) {
    const item = mission.scripts[Number(form.dataset.run)];
    if (item.confirm && !confirm(`Run "${item.title}"?`)) return;
    const output = form.nextElementSibling as HTMLElement; output.hidden = false; output.textContent = '';
    // Copy (Builder, 2026-10-18: "Yes" to phone Copy): a plain-text write from this tap only; the page never reads the clipboard (threat model row 19).
    const copy = output.nextElementSibling as HTMLButtonElement; copy.hidden = false; copy.textContent = 'Copy';
    copy.onclick = () => navigator.clipboard.writeText(output.textContent ?? '').then(() => 'Copied', () => 'Copy failed').then((said) => { copy.textContent = said; });
    const args = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].map((input) => input.value).filter((_, index, all) => all.slice(index).some(Boolean));
    const result = await mutate(`/scripts/${encodeURIComponent(item.id)}/run`, { args, ...(item.confirm && { confirm: true }) });
    if (result.status === 202) await follow(String(result.body.run), output).catch(() => { output.textContent += '\n[lost the run output]'; });
    else output.textContent = result.body.launched ? 'Started.' : `Could not run: ${result.body.reason ?? result.body.error ?? result.status}`;
  } else if (form.dataset.idea !== undefined) {
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement, note = form.querySelector<HTMLElement>('[data-note]')!;
    const result = await mutate('/mission/idea', { name: field('name').value, text: field('text').value, needs_done: field('needs').checked });
    note.textContent = result.status === 201 ? `Saved ${result.body.path}.` : `Not saved: ${result.body.error ?? result.status}`;
    if (result.status === 201) { form.reset(); typed.idea = null; setTimeout(() => void loadHub(), 900); }
  } else if (form.dataset.decide !== undefined) {
    const choice = ((event as SubmitEvent).submitter as HTMLButtonElement)?.value, note = form.querySelector<HTMLElement>('[data-note]')!;
    const result = await mutate('/mission/hub/decide', { name: form.dataset.decide, choice });
    note.textContent = result.status === 200 ? `Marked ${choice}.` : `Not saved: ${result.body.error ?? result.status}`;
    if (result.status === 200) setTimeout(() => void loadHub(), 900);
  } else if (form.dataset.answer !== undefined) {
    const item = mission.queue[Number(form.dataset.answer)], note = form.querySelector<HTMLElement>('[data-note]')!;
    const result = await mutate('/mission/answer', { name: item.name, hash: item.hash, answer: form.querySelector('textarea')!.value.replace(/\s+/g, ' ').trim() });
    if (result.status === 200) { note.textContent = 'Answer saved.'; form.querySelector('textarea')!.value = ''; delete typed.answers[item.name]; setTimeout(() => void loadMission(), 900); }
    else note.textContent = result.status === 409 ? 'The file changed since it loaded. Refresh and answer again.' : `Not saved: ${result.body.error ?? result.status}`;
  }
});
one('#mission').addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-open-page]');
  if (!button || !confirm(`Open this link on the laptop?\n\n${button.dataset.url}`)) return;
  const result = await mutate(`/pages/${encodeURIComponent(button.dataset.openPage!)}/launch`, { confirm: true });
  button.textContent = result.status === 200 ? 'Opened on the laptop' : `Not opened: ${result.body.reason ?? result.body.error ?? result.status}`;
});
one<HTMLButtonElement>('#refreshMission').onclick = () => void loadMission();

// A used-% bar: cyan, amber from 75%, red from 90%; a window that already reset shows empty.
const meter = (label: string, window: { usedPercent: number; resetsAt: number | null } | null) => {
  const pct = !window || (window.resetsAt && window.resetsAt < Date.now()) ? 0 : Math.min(100, Math.round(window.usedPercent));
  return `<div class="meter" role="meter" aria-label="${label} used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="track"><i${pct >= 90 ? ' class="bad"' : pct >= 75 ? ' class="warn"' : ''} style="width:${pct}%"></i></div><span>${label}</span></div>`;
};
// Spec §6: "$0.28 recorded". A cost under a cent is not shown as $0.00.
const cents = (usd: number) => usd > 0 && usd < 0.005 ? '< $0.01' : '$' + usd.toFixed(2);
// P9 (threat model row 31): sign in to Claude or Codex from the phone, the wizard's own login on the daemon's machine. The
// daemon hands over only a vendor's sign-in URL and Codex's code; the link is set as a property and opens only on a tap.
type SignIn = { signedIn: boolean; running: boolean; url: string | null; code: string | null; unsupported: boolean; exit: number | null };
const SIGN_IN: [agent: 'claude' | 'codex', name: string, page: string][] = [['claude', 'Claude', 'Claude'], ['codex', 'Codex', 'OpenAI']];
let signInShown = '', signInTimer = 0, signInData: Record<string, SignIn> | null = null;
const signInNote: Record<string, string> = {};
async function loadSignIn() {
  clearTimeout(signInTimer);
  const box = one('#signIn');
  // Unreachable after a first answer: the cards stay as last seen (a code typed in the box with them) and say so.
  let stale = false;
  try { signInData = await request('/phone/sign-in'); }
  catch { stale = true; }
  const data = signInData;
  if (!data) { box.innerHTML = '<article class="card warn"><h2>Sign-in unavailable</h2><p>The daemon did not answer.</p></article>'; signInShown = ''; return; }
  const key = JSON.stringify([data, signInNote, stale]);
  if (key !== signInShown) {
    signInShown = key;
    const typed = box.querySelector<HTMLInputElement>('[data-sign-code]')?.value ?? '';
    box.innerHTML = (stale ? '<p class="muted card">The daemon did not answer: this is the last sign-in state it sent.</p>' : '') + SIGN_IN.map(([agent, name, page]) => {
      const s = data[agent], note = signInNote[agent];
      const ended = !s.running && s.exit !== null && !s.signedIn;
      const said = s.unsupported ? `This Codex has no sign-in with a code (P9 was built with Codex 0.159.3, which has one). Sign in from the desktop's Sign in in a terminal and follow what Codex prints there.`
        : ended ? `${name} sign-in ended without signing in. Sign in starts it again; finish on ${page}'s page before it ends.` : '';
      const running = !s.running ? '' : !s.url ? '<p class="muted">Starting sign-in…</p>'
        : `<p><a data-sign-link="${agent}" target="_blank" rel="noopener noreferrer"></a></p>`
          + (agent === 'codex' ? (s.code ? `<p class="muted">Enter this one-time code there. It lasts 15 minutes.</p><p class="sign-code"><code>${escape(s.code)}</code></p>` : '<p class="muted">Getting a code…</p>')
            : `<p class="muted">After you sign in, Claude shows a code. Paste it here.</p><form class="sign-form" data-sign-send="${agent}"><input data-sign-code autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Claude's code" placeholder="Code from Claude" maxlength="512"><button type="submit">Send code</button></form>`);
      const act = s.running ? `<button type="button" data-sign="stop:${agent}">Cancel</button>`
        : `<button type="button" data-sign="start:${agent}">${s.signedIn || ended ? 'Sign in again' : 'Sign in'}</button>`;
      return `<article class="card sign-in${said || note ? ' warn' : ''}" data-agent="${agent}"><h2>${name} <small>${s.signedIn ? 'Signed in' : 'Not signed in'}</small></h2>${running}`
        + (said ? `<p>${escape(said)}</p>` : '') + (note ? `<p>${escape(note)}</p>` : '') + `<div class="sign-acts">${act}</div></article>`;
    }).join('');
    for (const link of box.querySelectorAll<HTMLAnchorElement>('[data-sign-link]')) {
      const agent = link.dataset.signLink as 'claude' | 'codex';
      link.href = data[agent].url!;
      link.textContent = `Open ${SIGN_IN.find(([a]) => a === agent)![2]}'s sign-in page`;
    }
    const input = box.querySelector<HTMLInputElement>('[data-sign-code]');
    if (input) input.value = typed;
  }
  if (SIGN_IN.some(([agent]) => data[agent].running) && !one<HTMLElement>('[data-view="usage"]').hidden) signInTimer = window.setTimeout(() => void loadSignIn(), 2000);
}
async function signIn(path: string, body: Json, agent: string) {
  try {
    const { status, body: result } = await mutate(path, body);
    signInNote[agent] = status < 300 ? '' : result.error === 'login-running' ? 'A sign-in is already running.' : result.error === 'login-not-running' ? 'That sign-in has ended. Sign in starts a new one.'
      : 'The daemon refused that (' + String(result.error ?? status) + ').';
    return status < 300;
  } catch (error) {
    signInNote[agent] = (error as Error).message === 'offline' ? 'You are offline. Nothing was sent; try again when back online.' : 'The daemon did not answer. Try again.';
    return false;
  } finally { void loadSignIn(); }
}
one('#signIn').addEventListener('click', (event) => {
  const [act, agent] = ((event.target as Element).closest<HTMLElement>('[data-sign]')?.dataset.sign ?? '').split(':');
  if (act) void signIn(act === 'start' ? '/phone/sign-in' : '/phone/sign-in/stop', { agent }, agent);
});
one('#signIn').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement, agent = form.dataset.signSend!, input = form.querySelector<HTMLInputElement>('[data-sign-code]')!;
  const code = input.value.trim();
  if (!code) return;
  // The typed code stays in the box until the daemon takes it.
  if (await signIn('/phone/sign-in/code', { agent, code }, agent)) input.value = '';
});
async function loadUsage() {
  void loadSignIn();
  try {
    const data = await request('/usage') as Usage;
    // Plan limits (5 h and week used %) from Claude Code's and Codex's own records: one row each, two bars under the text.
    const plan = (name: string, window: Limits | null) => { const l = limitLine(name, window, undefined, data.limits?.signedOut?.includes(name.toLowerCase())); return `<article class="plan${l.stale ? ' muted' : ''}"><h2>${l.name} plan</h2><small>${escape(l.text)}</small>${window ? `<div class="meters">${meter('5 h', window.fiveHour)}${meter('week', window.sevenDay)}</div>` : ''}</article>`; };
    const limits = data.limits ? `<div class="plans" data-limits>${plan('Claude', data.limits.claude)}${plan('Codex', data.limits.codex)}</div>` : '';
    if (data.state === 'unavailable') { one('#usage').innerHTML = limits + '<article class="card"><h2>No chat token records yet</h2><p>Token counts arrive when a P9 chat turn ends.</p></article>'; return; }
    const stale = data.state === 'stale' ? '<article class="card warn"><h2>Stale usage</h2><p>The latest record is more than 15 minutes old.</p></article>' : '';
    // Context fill per conversation (from usage_update), so a chat close to its limit shows before it stalls.
    const contexts = data.contexts.map((item) => { const pct = Math.round(item.used / item.size * 100); return `<div class="ctx"><span>${escape(item.provider)} context</span><b>${pct}%</b><div class="track"><i${pct >= 90 ? ' class="bad"' : pct >= 75 ? ' class="warn"' : ''} style="width:${Math.min(100, pct)}%"></i></div><small>${item.used.toLocaleString()} of ${item.size.toLocaleString()} tokens</small></div>`; }).join('');
    const none = data.samples ? '' : '<article class="card"><h2>No finished turns yet</h2><p>Token counts arrive when a chat turn ends; cost and context are already recorded.</p></article>';
    one('#usage').innerHTML = limits + stale + none + `<p class="sum"><b>${data.totals.inputTokens.toLocaleString()}</b> in · <b>${data.totals.outputTokens.toLocaleString()}</b> out · <b>${cents(data.totals.costUsd)}</b> recorded</p>`
      + (contexts ? `<div class="ctxs">${contexts}</div>` : '') + `<details class="more"><summary>Details</summary><p>${data.samples} samples · ${data.discarded} malformed discarded</p></details>`;
  } catch { one('#usage').innerHTML = '<article class="card warn"><h2>Usage unavailable</h2><p>The daemon did not answer.</p></article>'; }
}
one<HTMLButtonElement>('#refreshUsage').onclick = () => void loadUsage();

// The file browser: one workspace folder at a time ('' is the root), folders first; tapping a file opens the editor.
let folder = '';
async function loadFolder(path = folder) {
  try {
    const { entries } = await request('/files/list?path=' + encodeURIComponent(path)) as { entries: { name: string; dir?: boolean }[] };
    folder = path;
    one('#dirPath').textContent = path.split('/').pop() || 'Workspace';
    one<HTMLButtonElement>('#up').disabled = !path;
    const sorted = [...entries.filter((entry) => entry.dir), ...entries.filter((entry) => !entry.dir)];
    one('#fileList').innerHTML = sorted.map((entry) => `<li><button class="quiet" data-name="${escape(entry.name)}" data-dir="${entry.dir ? 1 : ''}">${entry.dir ? ICON.folder : ICON.file}${escape(entry.name)}</button></li>`).join('') || '<li class="empty">This folder is empty.</li>';
    one('#fileState').textContent = 'Pick a file';
  } catch (error) { one('#fileState').textContent = 'Folder unavailable'; one('#fileList').innerHTML = `<li class="empty">Could not list this folder (${escape((error as Error).message)}).</li>`; }
}
one('#fileList').addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-name]');
  if (!button) return;
  const path = folder ? folder + '/' + button.dataset.name : button.dataset.name!;
  void (button.dataset.dir ? loadFolder(path) : openFile(path));
});
one<HTMLButtonElement>('#up').onclick = () => void loadFolder(folder.split('/').slice(0, -1).join('/'));
one('#mission').addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-note]');
  if (!button) return;
  // opened first, so show() finds state.file set and does not load the workspace list over it; a note that cannot be
  // read says why on its own row
  void openFile(button.dataset.note!, button.dataset.noteRoot).then((opened) => {
    if (opened) { button.closest('dialog')?.close(); show('files'); } else button.lastElementChild!.textContent = one('#fileState').textContent;
  });
});
one<HTMLButtonElement>('#closeFile').onclick = () => { const back = state.file?.root; state.file = null; one<HTMLElement>('#fileView').hidden = true; one<HTMLElement>('#browser').hidden = false; online(); if (back) show('mission'); else void loadFolder(); };
// A .md file can be read rendered: md shows raw HTML as text and links and images as plain text (threat model row 18).
const preview = (on: boolean) => {
  one<HTMLElement>('#rendered').hidden = !on; one<HTMLElement>('#editor').hidden = on;
  if (on) one('#rendered').innerHTML = md.parse(editor.state.doc.toString()) as string;
};
// The Discard and Preview/Edit choices live in the bar's more menu (the shared sheet).
const discard = () => { if (state.file) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: state.file.content } }); };
one<HTMLButtonElement>('#moreFile').onclick = () => openSheet('File', (state.file && /\.md$/i.test(state.file.path) ? `<button type="button" class="opt" data-file="preview">${one<HTMLElement>('#rendered').hidden ? 'Preview' : 'Edit'}</button>` : '') + '<button type="button" class="opt" data-file="discard">Discard changes</button>');
one('#sheetBody').addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-file], [data-term]'); if (!button) return;
  if (button.dataset.term) { one<HTMLSelectElement>('#terminal').value = button.dataset.term; attach(); }
  else if (button.dataset.file === 'preview') preview(!!one<HTMLElement>('#rendered').hidden); else discard();
  sheet.close();
});
async function openFile(path: string, root?: string) {
  try {
    const file = await request(root ? '/mission/notes/file?' + new URLSearchParams({ root, path }) : '/files?path=' + encodeURIComponent(path)); state.file = { path, hash: file.hash, content: file.content, root };
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: file.content } });
    one('#openPath').textContent = path.split('/').pop()!; one<HTMLElement>('#openPath').title = path; one<HTMLElement>('#browser').hidden = true; one<HTMLElement>('#fileView').hidden = false;
    preview(!!root);
    one('#fileState').textContent = 'Loaded'; one<HTMLElement>('#conflict').hidden = true;
    online();
    return true;
  } catch (error) {
    // Binary, oversize, symlinked or locked files are refused by the daemon (request-refused); say so instead of "Unavailable".
    one('#fileState').textContent = (error as Error).message === 'request-refused' ? 'Cannot open this file here' : 'File unavailable';
    return false;
  }
}
async function saveFile(hash: string) {
  if (!state.file) return;
  const { path, root } = state.file, content = editor.state.doc.toString();
  const result = await mutate(root ? '/mission/notes/save' : '/files', root ? { root, path, hash, content } : { path, hash, content });
  if (result.status === 200) { state.file = { ...state.file, hash: String(result.body.hash), content, disk: undefined }; one('#fileState').textContent = 'Saved'; one<HTMLElement>('#conflict').hidden = true; syncSave(); }
  else if (result.status === 409) {
    // the disk version, when the file is still there, so the draft can be kept or the disk loaded (as on the desktop)
    state.file.disk = typeof result.body.diskHash === 'string' ? { content: String(result.body.diskContent), hash: result.body.diskHash } : undefined;
    one<HTMLElement>('#loadDisk').hidden = one<HTMLElement>('#saveMine').hidden = !state.file.disk;
    one('#fileState').textContent = 'Conflict'; one<HTMLElement>('#conflict').hidden = false;
  }
}
one<HTMLButtonElement>('#save').onclick = () => void saveFile(state.file?.hash ?? '');
one<HTMLButtonElement>('#saveMine').onclick = () => { if (state.file?.disk) void saveFile(state.file.disk.hash); };
one<HTMLButtonElement>('#loadDisk').onclick = () => {
  const disk = state.file?.disk; if (!state.file || !disk) return;
  state.file = { ...state.file, hash: disk.hash, content: disk.content, disk: undefined };
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: disk.content } });
  one('#fileState').textContent = 'Loaded'; one<HTMLElement>('#conflict').hidden = true; if (!one<HTMLElement>('#rendered').hidden) preview(true);
};

// ---- c18: the theme picker, Settings and Rebuild + reload, as on the desktop ----
// The Chats list's page-level actions, as the desktop's top bar has them: New chat, Theme and Settings (its icons, its ids).
function chatsBar(): BarOptions {
  return { title: 'Chats', acts: [{ id: 'newChat', label: 'New chat', icon: ICON.plus },
    { id: 'themeBtn', label: 'Theme', icon: desktopIcons.palette }, { id: 'setBtn', label: 'Settings', icon: desktopIcons.gear }] };
}
// The look is DUWOP's, saved on this phone (localStorage p9-look) the way the desktop saves its own, so each keeps its pick.
// The browser's own bar follows it: theme-color takes a plain colour and the themes are oklch, so it is read back from a canvas.
function paintBar() {
  const ctx = document.createElement('canvas').getContext('2d'); if (!ctx) return;
  ctx.fillStyle = '#080b10'; ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--background').trim() || '#080b10'; ctx.fillRect(0, 0, 1, 1);
  one<HTMLMetaElement>('meta[name="theme-color"]').content = '#' + [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((n) => n.toString(16).padStart(2, '0')).join('');
}
DUWOP.init(); paintBar(); onLookChange(paintBar);
function openTheme() { openSheet('Theme', '<div id="themeMenu"></div>'); DUWOP.menu(one('#themeMenu')); }
// Settings: Security settings and Mission Control files (c18, threat model row 66), as the desktop's Settings has them
// (security.mjs and mission-files.mjs: the same rows and words), through the desktop's own routes behind this phone's
// session, CSRF and op ID; then Maintenance. Rebuild + reload is offered only when the daemon runs from a source checkout.
const REBUILD = MAINTENANCE.find((item) => item.id === 'mtRebuild')!;
const START = 'p9-mode:'; // a new chat on the phone starts in its last pick for the agent (row 25)
type Build = { available: boolean; running: boolean } | null;
const sec: { lock: boolean | null; protect: boolean | null; settings: Record<string, unknown> | null; build: Build } = { lock: null, protect: null, settings: null, build: null };
async function openSettings() {
  openSheet('Settings', '<div id="phoneSettings" class="stack"><p class="muted">Loading…</p></div>');
  const [build, lock, protect, files] = await Promise.all(['/rebuild', '/agent-lock', '/file-protection', '/setup/settings'].map((path) => request(path).catch(() => null)));
  Object.assign(sec, { build, lock: lock?.on ?? null, protect: protect?.on ?? null, settings: files?.settings ?? null });
  drawSettings();
}
const toggle = (id: string, [label, note]: string[], checked: boolean, disabled = false) => `<label class="set"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span><strong>${escape(label)}</strong><span class="muted">${escape(note)}</span></span></label>`;
function drawSettings(note = '') {
  const box = document.getElementById('phoneSettings'); if (!box) return;
  const { lock, protect, settings, build } = sec;
  box.innerHTML = '<h2 class="eyebrow">Security settings</h2>'
    + toggle('setLock', lock === null ? [SECURITY.lock[0], SECURITY.unknown] : SECURITY.lock, lock === true, lock === null)
    + toggle('setProtect', protect === null ? [SECURITY.protect[0], SECURITY.unknown] : protect ? SECURITY.protect : [SECURITY.protect[0], SECURITY.protectOff], protect !== false, protect === null)
    + toggle('setWarn', SECURITY.warn, warnsLoose())
    + toggle('setFree', SECURITY.unrestricted, unrestricted(lock, protect, START), lock === null || protect === null)
    + `<p class="muted" id="secNote" role="status">${escape(note)}</p>`
    + (settings ? '<h2 class="eyebrow">Mission Control files</h2>' + missionKeys().map(([k, name]) => `<label class="mission-file"><strong>${escape(name)}</strong>`
      + (k === 'notes_roots' ? `<textarea class="mono" data-mission="${k}" rows="2" maxlength="8000" spellcheck="false">${escape(missionShown(k, settings[k]))}</textarea>`
        : `<input class="mono" data-mission="${k}" value="${escape(missionShown(k, settings[k]))}" maxlength="400" autocomplete="off" spellcheck="false">`) + '</label>').join('')
      + '<p class="muted">Each row saves when you leave it. The old file is kept as settings.json.bak.</p>' : '')
    + '<h2 class="eyebrow">Maintenance</h2>' + (build?.available
    ? `<button type="button" class="quiet" id="mtRebuild"${build.running ? ' disabled' : ''}>${build.running ? 'Rebuilding…' : REBUILD.label}</button>`
      + '<p class="muted" id="mtRebuildNote" role="status">Source checkouts only: rebuilds P9\'s pages from its source code (pnpm build), then reloads this page with the new build. Chats keep running; nothing restarts.</p>'
    : '<p class="muted">Rebuild + reload is for a P9 that runs from its source code. This machine runs an installed build.</p>');
  const button = document.getElementById('mtRebuild') as HTMLButtonElement | null;
  if (button) button.onclick = () => void rebuildUi(button);
  const input = (id: string) => one<HTMLInputElement>('#' + id);
  input('setLock').onchange = (event) => void setSecurity({ lock: (event.target as HTMLInputElement).checked });
  input('setProtect').onchange = (event) => void setSecurity({ protect: (event.target as HTMLInputElement).checked });
  input('setWarn').onchange = (event) => { setWarnsLoose((event.target as HTMLInputElement).checked); drawSettings(); };
  input('setFree').onchange = (event) => void setFree((event.target as HTMLInputElement).checked);
  box.querySelectorAll<HTMLInputElement>('[data-mission]').forEach((field) => { field.onchange = () => void saveMission(field); });
}
const said = (result: { status: number; body: Record<string, unknown> }) => String(result.body.detail ?? result.body.error ?? result.status);
const sent = (path: string, body: Json) => mutate(path, body).catch((error: Error) => ({ status: 0, body: { error: error.message } as Record<string, unknown> }));
// The lock and protection are the daemon's, for every device; protection off asks first, in the desktop's warning words.
async function setSecurity(change: { lock?: boolean; protect?: boolean }) {
  if (change.protect === false && !confirm('Turn off file protection?\n\n' + FILE_PROTECTION_RISK)) return drawSettings();
  const [path, key, on] = change.lock === undefined ? ['/file-protection', 'protect', change.protect!] as const : ['/agent-lock', 'lock', change.lock] as const;
  const result = await sent(path, { on });
  if (result.status === 200) sec[key] = result.body.on as boolean;
  drawSettings(result.status === 200 ? '' : 'Not changed: ' + said(result));
}
// Unrestricted mode: one confirm, then every restriction off; off puts the defaults back (the lock stays off).
async function setFree(on: boolean) {
  if (on && !confirm('Turn on Unrestricted mode?\n\n' + SECURITY.unrestricted[1] + '\n\n' + FILE_PROTECTION_RISK)) return drawSettings();
  for (const [path, key, want] of [['/file-protection', 'protect', !on], ['/agent-lock', 'lock', false]] as const) {
    if (sec[key] === want || (key === 'lock' && !on)) continue;
    const result = await sent(path, { on: want });
    if (result.status !== 200) return drawSettings('Not changed: ' + said(result));
    sec[key] = result.body.on as boolean;
  }
  setWarnsLoose(!on); setStarts(on, START);
  drawSettings();
}
// One row at a time, as on the desktop: the daemon checks it as it checks the file at start; a refusal stays with its reason.
async function saveMission(field: HTMLInputElement) {
  const result = await sent('/setup/settings', { [field.dataset.mission!]: missionValue(field.dataset.mission!, field.value) });
  if (result.status === 200) { sec.settings = result.body.settings as Record<string, unknown>; return drawSettings(); }
  field.setAttribute('aria-invalid', 'true'); field.closest('label')?.querySelector('[data-mission-err]')?.remove();
  field.closest('label')?.insertAdjacentHTML('beforeend', `<small class="field-err" data-mission-err role="alert">Not saved: ${escape(said(result))}</small>`);
}
// The desktop's mtRebuild: the button says Rebuilding… until the daemon answers, then the page loads the new build.
async function rebuildUi(button: HTMLButtonElement) {
  button.disabled = true; button.textContent = 'Rebuilding…';
  const result = await mutate('/rebuild', {}).catch((error: Error) => ({ status: 0, body: { error: error.message } as Record<string, unknown> }));
  if (result.status === 200 && result.body.rebuilt) { location.reload(); return; }
  button.disabled = false; button.textContent = REBUILD.label;
  one('#mtRebuildNote').textContent = 'Could not rebuild P9 (' + String(result.body.error ?? 'no-answer') + (result.body.detail ? ': ' + String(result.body.detail) : '') + ')';
}
one('[data-bar="chat"]').addEventListener('click', (event) => {
  const id = (event.target as Element).closest('button')?.id;
  if (id === 'themeBtn') openTheme(); else if (id === 'setBtn') void openSettings();
});

addEventListener('offline', online);
addEventListener('online', () => { online(); void loadChat().then(drain); });
// L2: the loading mark (phone.astro #boot) goes when the first load has answered, or failed (offline: the stale banner says so).
online(); const first = loadChat(); void first.finally(() => document.getElementById('boot')?.remove());
// P2: coming back to the app asks the daemon at once, so a session that ended meanwhile goes to the login now (request()),
// with the drafts kept, not on the next Save, Send or Stop.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && navigator.onLine) void request('/agent-lock').catch(() => {}); });
// P2: the file text kept by toLogin() comes back in the editor over the version it was read as, so Save still refuses
// to overwrite a file that changed on disk meanwhile.
void (async function keptFile() {
  let kept: { path?: unknown; root?: unknown; hash?: unknown; content?: unknown; text?: unknown } | null = null;
  try { kept = JSON.parse(localStorage.getItem('p9-file-draft') ?? 'null'); } catch {}
  if (!kept || typeof kept.path !== 'string' || typeof kept.hash !== 'string' || typeof kept.text !== 'string') return;
  const root = typeof kept.root === 'string' ? kept.root : undefined;
  if (!await openFile(kept.path, root)) return;
  localStorage.removeItem('p9-file-draft');
  state.file = { path: kept.path, hash: kept.hash, content: typeof kept.content === 'string' ? kept.content : '', root };
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: kept.text } });
  one('#fileState').textContent = 'Kept through sign-in, not saved'; show('files');
})();
if (localStorage.getItem('p9-mission-draft')) show('mission'); // P2: put back by keptMission() when Mission draws

void first.then(listen); void loadUsage();
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
// Item 19 (threat model row 65): on the phone an artifact opens in the full-screen sheet, the side panel's phone form
// (specs/side-panel.md). A chip in an agent reply opens it; so does Open on the plan (the Plan chip's sheet) or on Claude's
// plan-mode plan. The frame page is the server's /frame/ (its own CSP); comments go through the composer's send above.
// ponytail: nothing opens by itself on the phone (a sheet over the chat at every turn's end would bury the reply); the chip does.
const ART: { state: { art: Json; comments?: unknown[] } | null } = { state: null };
function artPlan(data: Json) { // Claude's plan-mode plan (the adapter's "Approve Plan" call, kind switch_mode), kept whole
  return data.kind === 'switch_mode' ? toolText(data).slice(0, 200000) || undefined : undefined;
}
async function artSend(text: string) {
  artSending = text;
  const sent = await (one<HTMLFormElement>('#composer').onsubmit as unknown as (event: unknown) => Promise<boolean | undefined>)({ preventDefault() {}, submitter: null });
  artSending = null;
  if (!sent) note('Comments not sent.');
  return !!sent;
}
function artOpen(art: Json) {
  if (!ART.state || ['kind', 'src', 'title'].some((key) => ART.state!.art[key] !== art[key])) ART.state = { art };
  dispatchEvent(new CustomEvent('p9-sheet', { detail: { title: String(art.title), html: '<div class="art-host"></div>', full: true } }));
  artifactView(one('#sheetBody .art-host'), ART.state, { page: '/frame/', base: '/frame/', send: artSend, modes: [] });
}
function artPlanOpen(src: string) { artOpen({ kind: 'markdown', lang: 'md', mode: 'full', title: 'Plan', src }); }
one('#events').addEventListener('click', (event) => {
  const target = event.target as Element, chip = target.closest<HTMLElement>('[data-artifact]'), plan = target.closest<HTMLElement>('[data-art-plan]');
  if (chip) artOpen(chipArtifact(chip));
  if (plan) artPlanOpen(plan.dataset.artPlan ?? '');
});
one('#sheetBody').addEventListener('click', (event) => {
  if (!(event.target as Element).closest('[data-open-plan="entries"]')) return;
  artPlanOpen(artEntries.map(([status, text]) => `- [${status === 'completed' ? 'x' : ' '}] ${text}${status === 'in_progress' ? ' *(in progress)*' : ''}`).join('\n'));
});
