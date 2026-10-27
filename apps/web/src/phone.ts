import { basicSetup, EditorView } from 'codemirror';
import { limitLine, md } from './helpers.mjs';
import { pinned, applyCard } from './pinned.mjs';
import { createTerminal, TMUX_MISSING, unavailableText } from './terminal.mjs';

type Json = Record<string, unknown>;
type Usage = { state: 'recorded' | 'stale' | 'unavailable'; updatedAt: number | null; samples: number; discarded: number; totals: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }; contexts: { provider: string; used: number; size: number }[]; limits?: { claude: Limits | null; codex: Limits | null } };
type Limits = { fiveHour: { usedPercent: number; resetsAt: number | null } | null; sevenDay: { usedPercent: number; resetsAt: number | null } | null; asOf: number };
const one = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const when = (ms: unknown) => new Date(Number(ms)).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
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
mountBar('chat', { title: 'Chats', acts: [{ id: 'newChat', label: 'New chat', icon: ICON.plus }] });
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
function openSheet(title: string, html: string) { one('#sheetTitle').textContent = title; one('#sheetBody').innerHTML = html; if (!sheet.open) sheet.showModal(); }
sheet.addEventListener('click', (event) => { if (event.target === sheet) sheet.close(); });
addEventListener('p9-sheet', (event) => { const { title, html } = (event as CustomEvent).detail; openSheet(String(title), String(html)); }); // ponytail: the one door into the sheet for code outside this file and for its test; callers pass trusted HTML
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
async function request(path: string) {
  const response = await fetch(path, { cache: 'no-store' });
  if (response.status === 401) { forgetMission(); location.replace('/login'); }
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
    forgetMission();
    location.replace('/login');
    return new Error('login-required');
  };
  // A reopened app keeps its cookie but not sessionStorage's CSRF token: log in again for a fresh one (release r1 R1-4).
  const csrf = sessionStorage.getItem('p9-csrf');
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

async function loadChat() {
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
  if ([...select.options].some((option) => option.value === was)) select.value = was;
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
    try { await pull(scoped ? '&only=' + ids.map(encodeURIComponent).join(',') : ''); break; }
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
}
async function fetchEvents(wait = 0) {
  if (!state.replayed) { await replay(); state.replayed = true; }
  else { await pull('', wait); gapAfter(state.events.find((event) => Number(event.cursor) > state.seen)); }
  state.seen = state.cursor; localStorage.setItem('p9-cursor', String(state.cursor));
}
// A stub chat's events, up to where the first read stopped; live events for it come after, so none repeat.
const loading = new Map<string, Promise<void>>();
function history(id: string) {
  if (!state.stubs.has(id)) return Promise.resolve();
  if (!loading.has(id)) loading.set(id, (async () => {
    try {
      for (let after = 0; ;) {
        const result = await request('/chat/events?after=' + after + '&only=' + encodeURIComponent(id) + '&until=' + state.base);
        state.events.push(...result.events as Json[]); after = Number(result.cursor);
        if ((result.events as Json[]).length < 500) break;
      }
    } catch (error) { if ((error as Error).message !== 'request-refused') throw error; } // an ID the daemon will not take has no history to show
    state.stubs.delete(id);
    state.events.sort((a, b) => Number(a.cursor) - Number(b.cursor));
  })().finally(() => loading.delete(id)));
  return loading.get(id)!;
}
// One readable block per message: streamed chunks are joined, a tool call keeps its latest status, and bookkeeping
// updates (usage, commands, titles) are left out. Each block is one <article data-kind=…> in #events.
type Block = { kind: string; text: string; id?: unknown; status?: string; detail?: string; request?: string; options?: Json[]; closed?: boolean };
type Item = { key: string; sig: string; html: () => string };
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
    if (kind === 'user') add('user', data.text);
    else if (kind === 'update') {
      const update = String(data.sessionUpdate), text = (data.content as Json | undefined)?.text ?? '';
      if (update === 'agent_message_chunk' || update === 'agent_thought_chunk') {
        const type = update === 'agent_message_chunk' ? 'agent' : 'think';
        if (last?.kind === type) last.text += String(text); else add(type, text);
      } else if (update === 'plan') strip.events = [{ t: 'plan', entries: (Array.isArray(data.entries) ? data.entries as Json[] : []).map((entry) => [String(entry?.status), String(entry?.content ?? '')]) }];
      else if (update === 'tool_call') add('tool', data.title || 'Tool call', { id: data.toolCallId, status: String(data.status || 'pending'), detail: toolText(data).slice(0, DETAIL_CAP) });
      else if (update === 'tool_call_update') {
        const tool = blocks.find((block) => block.kind === 'tool' && block.id === data.toolCallId);
        if (tool) {
          if (typeof data.status === 'string') tool.status = data.status;
          if (typeof data.title === 'string' && data.title) tool.text = data.title;
          const more = toolText(data); if (more) tool.detail = ((tool.detail ? tool.detail + '\n' : '') + more).slice(0, DETAIL_CAP);
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
      add('answered', 'You answered · ' + (outcome ? (outcome.outcome === 'selected' ? String(chosen?.name ?? outcome.optionId) : 'Cancelled') : String(answer.action)));
    }
    else if (kind === 'question') add('ask', data.message, { id: data.request });
    else if (kind === 'turn-end') { settle(); if (data.stopReason !== 'end_turn') add('note', 'Turn ended · ' + data.stopReason); }
    else if (kind === 'error') add('error', data.message);
    else if (kind === 'steer-lost') add('note', 'This message may not have reached the agent · ' + data.text);
    else if (kind === 'interrupted') { settle(); add('note', 'Stopped · The P9 daemon restarted mid-turn. Send again to resume.'); }
    else if (kind === 'exited' || kind === 'stopped') { settle(); add('note', 'Stopped · Send again to resume.'); }
  }
  return { blocks, strip };
}
const toolRow = (block: Block) => `<article data-kind="tool" data-status="${escape(block.status)}"><details><summary><span class="st"></span><span class="t">${escape(block.text)}</span></summary><pre>${escape([block.status, block.detail].filter(Boolean).join('\n'))}</pre></details></article>`;
function blockHtml(block: Block) {
  const kind = block.kind;
  if (kind === 'user') return `<article data-kind="user" class="msg user">${escape(block.text)}</article>`;
  if (kind === 'agent') return `<article data-kind="agent" class="msg md">${md.parse(block.text)}</article>`;
  if (kind === 'think') return `<article data-kind="think"><details><summary>Thinking</summary><div>${escape(block.text)}</div></details></article>`;
  if (kind === 'tool') return toolRow(block);
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
  const out: Item[] = [];
  for (let i = 0; i < blocks.length; i++) {
    let j = i; while (blocks[j].kind === 'tool' && blocks[j + 1]?.kind === 'tool') j++;
    if (j - i >= 2) {
      const run = blocks.slice(i, j + 1);
      out.push({ key: 'g' + i, sig: JSON.stringify(run), html: () => `<article data-kind="group" data-status="${run.some((block) => block.status === 'in_progress' || block.status === 'pending') ? 'in_progress' : 'completed'}"><details><summary><span class="st"></span><span class="t">Ran ${run.length} tools</span></summary>${run.map(toolRow).join('')}</details></article>` });
      i = j;
    } else { const block = blocks[i]; out.push({ key: 'b' + i, sig: JSON.stringify(block), html: () => blockHtml(block) }); }
  }
  return out;
}
type Keyed = HTMLElement & { sig?: string };
// Appends and patches: every node whose key and signature still hold stays in the page (scroll position, text selection and
// an expanded row survive a long-poll tick); only a changed block is replaced, a new one inserted, a gone one removed.
function patch(list: HTMLElement, wanted: Item[]) {
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
    else if (['turn-end', 'interrupted', 'exited', 'stopped', 'closed'].includes(kind)) { chat.working = false; chat.open.clear(); }
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
  const html = `<button type="button" class="back" data-back aria-label="Back to Chats">${ICON.back}Chats</button><div class="title"><h1>${escape(item?.title || agent)}</h1><button type="button" class="sub" id="modelBtn" aria-label="Model">${escape(agent + (name ? ' · ' + name : ''))} ${ICON.chevron}</button></div><span class="run" data-run="${run}" role="img" aria-label="${run === 'working' ? 'Working' : run === 'needs' ? 'Needs you' : 'Stopped'}"></span><span class="sync" role="img" aria-label="Live"></span>`;
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
  one('#chatList').hidden = !!id; one('#chatArea').hidden = !id; one('#composerSlot').hidden = !id;
  document.body.classList.toggle('inchat', !!id && document.body.dataset.view === 'chat');
  barSig = '';
  if (!id) { pushed = false; mountBar('chat', { title: 'Chats', acts: [{ id: 'newChat', label: 'New chat', icon: ICON.plus }] }); online(); renderList(); return; }
  if (changed) { one('#events').replaceChildren(); windowSize = 60; seenItems = 0; stuck = true; one('#jump').hidden = true; }
  render();
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
  const { blocks, strip } = build(picked), all = itemsOf(blocks), events = one('#events');
  if (!stuck && seenItems) windowSize += Math.max(0, all.length - seenItems); // a reader part way up keeps their top; the window slides only at the bottom
  seenItems = all.length;
  const shown = all.slice(-windowSize);
  hiddenBlocks = all.length - shown.length;
  const height = body.scrollHeight, top = body.scrollTop;
  patch(events, shown);
  if (!blocks.length) events.insertAdjacentHTML('beforeend', '<div class="empty">No messages yet.</div>');
  if (stuck) body.scrollTop = body.scrollHeight; else if (anchored) body.scrollTop = top + body.scrollHeight - height; // older blocks inserted above keep the reader where they were
  anchored = false;
  const plan = (strip.events[0]?.entries ?? []) as string[][], cards = strip.cards?.size ?? 0, chips = one('#chips');
  one('#pinned').innerHTML = pinned(strip, (card: { text: string }) => md.parse(card.text) as string);
  chips.hidden = !plan.length && !cards;
  chips.innerHTML = (plan.length ? `<button type="button" class="chip" data-chip>Plan ${plan.filter((entry) => entry[0] === 'completed').length}/${plan.length} ▸</button>` : '') + (cards ? `<button type="button" class="chip" data-chip>${cards} pinned ▸</button>` : '');
  chatBar(picked, digest().get(picked)?.run ?? 'idle');
  renderPicks(picked); renderQueue(); label(); void drain();
}
body.addEventListener('scroll', () => {
  stuck = body.scrollHeight - body.scrollTop - body.clientHeight < 80; one('#jump').hidden = stuck;
  if (body.scrollTop < 60 && hiddenBlocks > 0) { windowSize += 60; anchored = true; render(); } // older history loads when the reader reaches the top
}, { passive: true });
new ResizeObserver(() => { if (stuck) body.scrollTop = body.scrollHeight; }).observe(body);
new ResizeObserver(() => { if (stuck) body.scrollTop = body.scrollHeight; }).observe(one('#events'));
one<HTMLButtonElement>('#jump').innerHTML = ICON.down;
one<HTMLButtonElement>('#jump').onclick = () => body.scrollTo({ top: body.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
one('#chips').onclick = (event) => { if ((event.target as Element).closest('[data-chip]')) openSheet('Plan and pinned', one('#pinned').innerHTML); };
one('#chatList').onclick = (event) => { const row = (event.target as Element).closest<HTMLElement>('[data-chip],[data-chat]'); if (row?.dataset.chat) openChat(row.dataset.chat); };
one('[data-bar="chat"]').addEventListener('click', (event) => {
  const button = (event.target as Element).closest('button'); if (!button) return;
  if (button.dataset.back !== undefined) back();
  else if (button.id === 'newChat') openSheet('New chat', `<button type="button" class="opt" data-new="claude">New Claude chat</button><button type="button" class="opt" data-new="codex">New Codex chat</button>`);
  else if (button.id === 'modelBtn') {
    const model = one<HTMLSelectElement>('#model'), options = [...model.options];
    openSheet('Model', options.length ? options.map((option) => `<button type="button" class="opt" data-model="${escape(option.value)}" aria-checked="${option.selected}">${escape(option.textContent)}</button>`).join('') : '<div class="empty">This agent lists no models.</div>');
  }
});
one('#sheetBody').addEventListener('click', async (event) => {
  const target = event.target as Element, pick = target.closest<HTMLElement>('[data-model]'), make = target.closest<HTMLElement>('[data-new]');
  if (pick) { const model = one<HTMLSelectElement>('#model'); model.value = pick.dataset.model!; model.dispatchEvent(new Event('change')); barSig = ''; sheet.close(); render(); }
  if (make) {
    if (!navigator.onLine) return;
    sheet.close();
    const result = await mutate('/chat', { provider: make.dataset.new });
    if (result.status !== 201) return;
    await loadChat(); openChat(String(result.body.conversation));
  }
});
// Mode and Model for the picked chat (Builder, 2026-10-18: the phone could change neither; threat model row 15). Mode
// starts at "as set" and sends nothing until picked: the daemon does not report the mode, and a default would undo a
// Plan picked on the desktop. Model lists the agent's own models from its newest config event.
const MODES: Record<string, string[]> = { claude: ['Auto', 'Manual', 'Plan', 'Accept edits'], codex: ['Read-only', 'Workspace access', 'Auto review'] }; // Full access and bypass only on the desktop, behind its warning (threat model row 25)
let picksFor = '';
function renderPicks(id: string) {
  const configs = state.events.filter((event) => event.conversation === id && event.type === 'config'), key = id + ':' + configs.length;
  if (key === picksFor) return;
  const mode = one<HTMLSelectElement>('#mode'), keep = picksFor.startsWith(id + ':') ? mode.value : '';
  picksFor = key;
  const provider = String(state.conversations.find((item) => item.id === id)?.provider ?? '');
  mode.innerHTML = '<option value="">Mode: as set</option>' + (MODES[provider] ?? []).map((name) => `<option value="${escape(name)}">Mode: ${escape(name)}</option>`).join('');
  mode.value = keep;
  const config = (configs.at(-1)?.data ?? {}) as { model?: { current?: string; options?: { value: string; name: string }[] } };
  const model = one<HTMLSelectElement>('#model'), options = config.model?.options ?? [];
  model.hidden = !options.length; model.dataset.current = config.model?.current ?? '';
  model.innerHTML = options.map((o) => `<option value="${escape(o.value)}"${o.value === config.model?.current ? ' selected' : ''}>${escape(o.name)}</option>`).join('');
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
type Queued = { qid: string; text: string; mode?: string; model?: string };
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
function label() {
  const id = one<HTMLSelectElement>('#conversation').value;
  one('#composer button').textContent = !navigator.onLine || asking(id) || queued(id).length ? 'Queue message' : 'Send message';
}
function renderQueue() {
  const id = one<HTMLSelectElement>('#conversation').value, items = queued(id), box = one<HTMLElement>('#queued');
  box.hidden = !items.length;
  box.innerHTML = items.map((item) => `<article class="event tool"><b>Queued</b><p>${escape(item.text)}</p><button type="button" class="quiet" data-unqueue="${escape(item.qid)}">Take back</button></article>`).join('');
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
          one('#events').insertAdjacentHTML('beforeend', `<div class="empty">Not sent: ${escape(result.body.error ?? result.status)}</div>`);
        }
      }
    }
  } catch { /* a lost request keeps its message and its ID; the next drain sends it again */ }
  finally { draining = false; }
  if (sent) { await fetchEvents(); render(); } else renderQueue();
}
one<HTMLElement>('#queued').onclick = (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-unqueue]'); if (!button) return;
  const id = one<HTMLSelectElement>('#conversation').value, item = queued(id).find((entry) => entry.qid === button.dataset.unqueue); if (!item) return;
  keepQueue(id, queued(id).filter((entry) => entry.qid !== item.qid));
  const input = one<HTMLTextAreaElement>('#prompt'); input.value = item.text + (input.value ? '\n' + input.value : '');
  renderQueue(); label();
};
one<HTMLFormElement>('#composer').onsubmit = async (event) => {
  event.preventDefault(); const id = one<HTMLSelectElement>('#conversation').value; const input = one<HTMLTextAreaElement>('#prompt');
  if (!id || !input.value.trim()) return;
  const mode = one<HTMLSelectElement>('#mode').value, model = one<HTMLSelectElement>('#model');
  const body = { text: input.value.trim(), ...(mode && { mode }), ...(model.value && model.value !== model.dataset.current && { model: model.value }) };
  // Behind a queued message it queues too, so they go in the order typed.
  if (!navigator.onLine || asking(id) || queued(id).length) { keepQueue(id, [...queued(id), { qid: crypto.randomUUID(), ...body }]); input.value = ''; renderQueue(); label(); void drain(); return; }
  const result = await mutate('/chat/' + encodeURIComponent(id) + '/prompt', body);
  // A refused send says so; it used to leave the box filled with no sign anything happened.
  if (result.status === 202) { input.value = ''; await fetchEvents(); render(); }
  else one('#events').insertAdjacentHTML('beforeend', `<div class="empty">Not sent: ${escape(result.body.error ?? result.status)}</div>`);
};
one<HTMLSelectElement>('#conversation').onchange = render; // a stub's history loads from render
// Phase 17 row 2: an approval answered from the phone, the same POST /chat/:id/answer the desktop uses.
one<HTMLElement>('#events').onclick = async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-request]'); if (!button) return;
  const id = one<HTMLSelectElement>('#conversation').value;
  button.parentElement!.querySelectorAll('button').forEach((item) => { item.disabled = true; });
  const result = await mutate('/chat/' + encodeURIComponent(id) + '/answer', { request: button.dataset.request, answer: { optionId: button.dataset.option } });
  if (result.status === 200) { await fetchEvents(); render(); }
  else { button.parentElement!.querySelectorAll('button').forEach((item) => { item.disabled = false; }); one('#events').insertAdjacentHTML('beforeend', `<div class="empty">Not answered: ${escape(result.body.error ?? result.status)}</div>`); }
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
  one('#termTitle').textContent = id ? picked.selectedOptions[0].textContent : 'Terminal';
  if (!id) { term.close(); return termState('No terminal open'); }
  if (!navigator.onLine) { term.close(); return termState('Offline: terminal closed'); }
  term.attach(id);
}
async function loadTerminals() {
  try {
    const list = ((await request('/terminals')).terminals ?? []) as Json[];
    const select = one<HTMLSelectElement>('#terminal'), was = select.value;
    const running = list.filter((item) => item.state === 'running').reverse();
    select.innerHTML = running.map((item) => `<option value="${escape(item.id)}">${escape('Terminal · ' + when(item.created))}</option>`).join('') || '<option value="">No terminals yet</option>';
    if (running.some((item) => item.id === was)) select.value = was;
    attach();
  } catch (error) {
    const { message, body } = error as Error & { body?: Json };
    termState(message === 'tmux-not-found' ? TMUX_MISSING : message === 'terminal-unavailable' ? unavailableText(body?.reason) : 'Terminals are unavailable');
  }
}
one<HTMLSelectElement>('#terminal').onchange = attach;
one('#pickTerminal').onclick = () => {
  const select = one<HTMLSelectElement>('#terminal'), options = [...select.options].filter((option) => option.value);
  if (options.length) openSheet('Terminals', options.map((option) => `<button type="button" class="opt" role="menuitemradio" aria-checked="${option.value === select.value}" data-term="${escape(option.value)}">${escape(option.textContent)}</button>`).join(''));
};
one<HTMLButtonElement>('#refreshTerminal').onclick = () => void loadTerminals();
one<HTMLButtonElement>('#newTerminal').onclick = async () => {
  const result = await mutate('/terminals', {});
  if (result.status !== 201) return termState(result.body.error === 'tmux-not-found' ? TMUX_MISSING
    : result.body.error === 'terminal-unavailable' ? unavailableText(result.body.reason) : 'Not started: ' + String(result.body.error ?? result.status));
  one<HTMLSelectElement>('#terminal').value = ''; await loadTerminals();
  one<HTMLSelectElement>('#terminal').value = String(result.body.terminal); attach();
};
one<HTMLButtonElement>('#stopTerminal').onclick = async () => {
  const id = one<HTMLSelectElement>('#terminal').value; if (!id) return;
  const result = await mutate('/terminals/' + encodeURIComponent(id) + '/stop', {});
  if (result.status !== 200) return termState('Stop failed: ' + String(result.body.error ?? result.body.result ?? result.status));
  await loadTerminals();
};
document.querySelectorAll<HTMLButtonElement>('#keys button').forEach((button) => { button.onclick = async () => {
  if (button.dataset.key === 'paste') { try { const text = await navigator.clipboard.readText(); if (text) term.sendKeys(text); } catch { one('#termState').textContent = 'Paste was not allowed'; } } // the phone's clipboard, only on this tap
  else term.sendKeys(KEYS[button.dataset.key!]);
  term.focus();
}; });
addEventListener('resize', term.fit); window.visualViewport?.addEventListener('resize', term.fit); // the screen fills the column, which follows a keyboard
addEventListener('offline', () => { if (term.close()) termState('Offline: terminal closed'); });
termState('No terminal open');
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
  render();
  const again = windowNow() as HTMLDialogElement | null;
  if (again && !again.open) again.showModal();
  rows(again).forEach((d) => { if (!d.open && expanded.has(title(d))) d.open = true; });
}
// T7: the last Mission and hub answers are kept here and in localStorage (threat model row 56; a 401 forgets them). A tap
// on Mission draws them at once, then both routes refresh behind; before, the page waited on GET /mission, then emptied
// #hub and waited on GET /mission/hub.
const kept = (key: string) => { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } };
const keep = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }; // storage full: no cache
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
    const groups = new Map<string, string[]>();
    (data.scripts as Item[]).forEach((item, index) => {
      const inputs = (item.args as unknown as (string | { label: string; choices?: string[] })[]).map((arg) => typeof arg === 'string'
        ? `<label>${escape(arg)}<input maxlength="8000" autocomplete="off" /></label>`
        : `<label>${escape(arg.label)}<select><option value="">(none)</option>${(arg.choices ?? []).map((choice) => `<option>${escape(choice)}</option>`).join('')}</select></label>`).join('');
      const body = `${item.desc ? `<p>${escape(item.desc)}</p>` : ''}` + (item.terminal
        ? '<p class="muted">Laptop only: this script opens a terminal window.</p>'
        : `<form data-run="${index}">${inputs}<button type="submit">${item.confirm ? 'Run (asks first)' : 'Run'}</button></form><pre data-output hidden></pre><button type="button" data-copy hidden>Copy</button>`);
      groups.set(item.group || 'Scripts', [...(groups.get(item.group || 'Scripts') ?? []), row(escape(item.title), body)]);
    });
    // The free-form space: a section's buttons arrived with the scripts above; its text and log views join the same group.
    const notes = new Map<string, string>();
    for (const space of (data.space ?? []) as { title: string; text: string; logs: { id: string; title: string }[]; notes?: string }[]) {
      if (space.text) notes.set(space.title, `<p class="muted" data-space-text>${escape(space.text)}</p>`);
      // Notes (threat model row 34): the list loads when the row opens; a note opens in the file editor below.
      const folder = space.notes ? [row(`Notes<small>${escape(space.notes)}</small>`, `<div data-notes="${escape(space.notes)}"><p class="muted">Loading…</p></div>`)] : [];
      groups.set(space.title, [...(groups.get(space.title) ?? []), ...folder, ...space.logs.map((log) => row(escape(log.title), lazy({ kind: 'space', name: log.id })))]);
    }
    const links = [...data.pages, ...data.apps.filter((item: Item) => item.url)].map((item: Item) => (/^https?:\/\//i.test(item.url)
      ? `<li><a class="link" href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">${escape(item.title)}</a></li>`
      // M6: another program's link opens on the laptop only after the full link was shown and confirmed.
      : `<li><button type="button" class="link" data-open-page="${escape(item.id)}" data-url="${escape(item.url)}">${escape(item.title)} (opens on the laptop)</button></li>`)).join('');
    const laptopApps = data.apps.filter((item: Item) => !item.url).length;
    const status = escape(String(data.primary?.status ?? '').replace(/\*\*/g, ''));
    keepOpen(() => { one('#mission').innerHTML = (data.restart?.needed ? `<article class="card warn"><h2>Restart P9 to apply</h2><p>The workspace folder ${escape(data.restart.folder)} was not there when P9 started, so it is using the default folder. Restart P9 on the computer.</p></article>` : '') + (data.settingsError ? `<article class="card warn"><h2>Settings</h2><p>settings.json has a problem, so the last good settings are in use: ${escape(data.settingsError)}</p></article>` : '') + (data.invalid.length ? `<article class="card warn"><h2>Registry</h2><p>${data.invalid.length} entries are malformed and hidden.</p></article>` : '')
      + '<div class="tiles"><h2 class="grp a">Needs attention</h2><h2 class="grp b">Everything else</h2>'
      + win('queue', 'Waiting on you', data.queue.length, data.queue[0] ? escape(data.queue[0].title) : 'Nothing is waiting on you.', queue || '<div class="empty">Nothing is waiting on you.</div>')
      + win('primary', 'Main project', escape(data.primary?.name ?? 'None'), status, `<article class="card"><h2>${escape(data.primary?.name ?? 'No primary project')}</h2><small>${status}</small></article>`)
      + '<div id="hub"></div>'
      + [...groups].map(([group, rows], index) => win('g' + index, escape(group), rows.length, 'scripts', (notes.get(group) ?? '') + rows.join(''))).join('')
      + win('pages', 'Pages', data.pages.length, 'links', `<ul class="list">${links}</ul>` + (laptopApps ? `<p class="muted">${laptopApps} laptop apps open from the desktop.</p>` : ''))
      + '</div>'; });
    missionDrawn = true;
    if (!cached) { lastMission = data; keep('p9-mission', data); }
  } catch { if (cached) lastMission = null; else if (!missionDrawn) one('#mission').innerHTML = '<div class="empty">Mission Control is unavailable.</div>'; return; }
  if (lastHub) void loadHub(true); // the redraw above emptied #hub: refill it from memory, not from the wire
  if (!cached) void loadHub();
}
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
  if (o.notices === null && !cached) setTimeout(() => void loadHub(), 15000);
}
one('#mission').addEventListener('click', (event) => {
  const target = event.target as Element;
  const open = target.closest<HTMLElement>('[data-open]');
  if (open) { openWindow = open.dataset.open!; (document.getElementById('w-' + openWindow) as HTMLDialogElement).showModal(); }
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
    if (result.status === 201) setTimeout(() => void loadHub(), 900);
  } else if (form.dataset.decide !== undefined) {
    const choice = ((event as SubmitEvent).submitter as HTMLButtonElement)?.value, note = form.querySelector<HTMLElement>('[data-note]')!;
    const result = await mutate('/mission/hub/decide', { name: form.dataset.decide, choice });
    note.textContent = result.status === 200 ? `Marked ${choice}.` : `Not saved: ${result.body.error ?? result.status}`;
    if (result.status === 200) setTimeout(() => void loadHub(), 900);
  } else if (form.dataset.answer !== undefined) {
    const item = mission.queue[Number(form.dataset.answer)], note = form.querySelector<HTMLElement>('[data-note]')!;
    const result = await mutate('/mission/answer', { name: item.name, hash: item.hash, answer: form.querySelector('textarea')!.value.replace(/\s+/g, ' ').trim() });
    if (result.status === 200) { note.textContent = 'Answer saved.'; setTimeout(() => void loadMission(), 900); }
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
async function loadUsage() {
  try {
    const data = await request('/usage') as Usage;
    // Plan limits (5 h and week used %) from Claude Code's and Codex's own records: one row each, two bars under the text.
    const plan = (name: string, window: Limits | null) => { const l = limitLine(name, window); return `<article class="plan${l.stale ? ' muted' : ''}"><h2>${l.name} plan</h2><small>${escape(l.text)}</small>${window ? `<div class="meters">${meter('5 h', window.fiveHour)}${meter('week', window.sevenDay)}</div>` : ''}</article>`; };
    const limits = data.limits ? `<div class="plans" data-limits>${plan('Claude', data.limits.claude)}${plan('Codex', data.limits.codex)}</div>` : '';
    if (data.state === 'unavailable') { one('#usage').innerHTML = limits + '<article class="card"><h2>No chat token records yet</h2><p>Token counts arrive when a P9 chat turn ends.</p></article>'; return; }
    const stale = data.state === 'stale' ? '<article class="card warn"><h2>Stale usage</h2><p>The latest record is more than 15 minutes old.</p></article>' : '';
    // Context fill per conversation (from usage_update), so a chat close to its limit shows before it stalls.
    const contexts = data.contexts.map((item) => { const pct = Math.round(item.used / item.size * 100); return `<div class="ctx"><span>${escape(item.provider)} context</span><b>${pct}%</b><div class="track"><i${pct >= 90 ? ' class="bad"' : pct >= 75 ? ' class="warn"' : ''} style="width:${Math.min(100, pct)}%"></i></div><small>${item.used.toLocaleString()} of ${item.size.toLocaleString()} tokens</small></div>`; }).join('');
    const none = data.samples ? '' : '<article class="card"><h2>No finished turns yet</h2><p>Token counts arrive when a chat turn ends; cost and context are already recorded.</p></article>';
    one('#usage').innerHTML = limits + stale + none + `<p class="sum"><b>${data.totals.inputTokens.toLocaleString()}</b> in · <b>${data.totals.outputTokens.toLocaleString()}</b> out · <b>$${data.totals.costUsd.toFixed(4)}</b> recorded</p>`
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
  else if (button.dataset.file === 'preview') preview(one<HTMLElement>('#rendered').hidden); else discard();
  sheet.close();
});
async function openFile(path: string, root?: string) {
  try {
    const file = await request(root ? '/mission/notes/file?' + new URLSearchParams({ root, path }) : '/files?path=' + encodeURIComponent(path)); state.file = { path, hash: file.hash, content: file.content, root };
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: file.content } });
    one('#openPath').textContent = path.split('/').pop()!; one('#openPath').title = path; one<HTMLElement>('#browser').hidden = true; one<HTMLElement>('#fileView').hidden = false;
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

addEventListener('offline', online);
addEventListener('online', () => { online(); void loadChat().then(drain); });
online(); void loadChat().then(listen); void loadUsage();
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
