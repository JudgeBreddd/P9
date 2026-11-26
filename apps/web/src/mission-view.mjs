// Mission Control's page: sections, windows, the space menu, notes and file modals. Split out of controller.mjs's mountShell (F9) with no change in behaviour; names that stay in mountShell come in through outer.
import { tileLevel, tileAnswer, tileHtml, quickNoteHtml, linkHtml, quickNotePath, quickNoteWords } from './data-tiles.mjs';
import { esc, limitItems, profileLines, FILE_IMAGE, copy, fileImageSrc, fileImageError, md } from './helpers.mjs';
import { editItems } from './mission-files.mjs';
import { freeName, templateWords } from './onboarding.mjs';
import { checklistHtml, checklistAnswer, checklistAction } from './checklist.mjs';
import { partOrder, PARTS, WIDGETS } from '../../../packages/protocol/index.mjs';
import { mountCard } from './artifact.mjs';

export function installMission(outer) {
const tint = s => ` style="--tint:${outer.CTP[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % outer.CTP.length]}"`;
const worst = list => ['bad', 'warn', 'ok'].find(l => list.some(s => s[3] === l)) || 'ok';
// A space section's level: the worst of its data tiles' and cards' last answers ('' when none is warn or bad), set by sectionBody.
const secLv = {};
function pullTopLevels() {
  if (outer.S.focus !== 'mission' || document.hidden || !window.p9?.mission || Date.now() - outer.topAt < 29000) return;
  outer.topAt = Date.now();
  for (const s of outer.M.space || []) {
    const runs = PLACED.test(s.place) ? [] : [...(s.data || []), ...(s.cards || [])];
    if (runs.length) Promise.all(runs.map(d => window.p9.mission('data', { id: d.id }).then(r => tileLevel(tileAnswer(r.status, r.body)), () => ''))).then(l => {
      const lv = ['bad', 'warn'].find(x => l.includes(x)) || '';
      if ((secLv[s.id] || '') !== lv) { secLv[s.id] = lv; outer.renderMission(); }
    });
  }
}
const secWorst = (g, l) => { const w = worst(l), v = secLv[g]; return w === 'bad' || v === 'bad' ? 'bad' : w === 'warn' || v === 'warn' ? 'warn' : w; };
const panel = (id, title, body, extra = '') => `<section class="panel" id="${id}"><h3>${title}${extra}</h3><div class="pbody">${body}</div></section>`;
const noUsage = () => ({ state: 'unavailable', samples: 0, discarded: 0, totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
const usage = noUsage();
let usageRead = 0; // the newest read; an older answer that lands later is dropped
async function loadUsage() {
  if (!window.p9?.usage) return;
  const seq = ++usageRead, started = Date.now();
  const result = await window.p9.usage().catch(() => ({ status: 503, body: { state: 'unavailable' } }));
  if (seq !== usageRead) return;
  // O190/O191 FIX1: each answer replaces the last one whole, so a field an older daemon does not send (tokens, profiles,
  // limits) or a failed read leaves nothing of the previous answer behind. A failed read keeps only the plan limits: they
  // carry their own age (limitLine: "N min old", muted by the daemon's stale mark), and dropping them would blank every chat's meter on a blip.
  // A3 (3): a read that began before Settings > General's switch was saved (tabSetAt) keeps the saved value.
  const kept = { ...(result.status === 200 ? result.body : { limits: usage.limits, telemetryTab: usage.telemetryTab }),
    ...(usage.tabSetAt > started && { telemetryTab: usage.telemetryTab, tabSetAt: usage.tabSetAt }) };
  const was = usage.telemetryTab;
  for (const key of Object.keys(usage)) delete usage[key];
  Object.assign(usage, noUsage(), kept);
  outer.renderMission();
  // A changed switch shows at once in an open Usage window (Mission's onboarding draws no panels) and in Settings > General
  // (unless a change of its own is being saved there).
  if (usage.telemetryTab !== was) { redrawUsage(); const box = document.getElementById('setUsageTabs'); if (box && !box.disabled) box.checked = usage.telemetryTab !== false; }
}
// The chat meters read usage.limits: fetched again each minute, and at once when Claude reports its limits or any turn
// ends (Codex writes its limits to its session log each turn). The cache clock moves on every 15 s without a re-render.
// Not while the window is hidden: each read tells the daemon someone is looking, which keeps its Claude usage poll (and the
// claude process behind it) going; with no reads it stops after 2 min (claude-usage.mjs). Shown again, it reads at once.
const pollUsage = () => { if (!document.hidden) loadUsage().then(outer.renderChats); outer.setTimeout(pollUsage, 60000); };
// Panes are redrawn only when the figures moved, so a turn end in one chat does not rebuild the others (E2).
const usageNow = () => { clearTimeout(outer.usageSoon); outer.usageSoon = outer.setTimeout(() => { const was = JSON.stringify(usage.limits); loadUsage().then(() => { if (JSON.stringify(usage.limits) !== was) outer.renderChats(); }); }, 300); };
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
  outer.toast({ kind: r.restarted ? done : 'not ' + done, txt: r.restarted ? 'P9 ' + done + '.' : outer.WIZ_ERR[r.error]?.join(' ') ?? 'Could not ' + (repair ? 'repair' : 'restart') + ' P9 (' + r.error + (r.detail ? ': ' + r.detail : '') + ')', level: r.restarted ? 'ok' : 'bad' }, true);
  if (r.restarted) loadMission();
}
// Overview reads overlap (the 20 s poll, a Mission click, a turn's end) and can answer out of order; an answer older than one
// already taken is dropped, or it draws the window back to the file as it was (M5 CI, job 133105928886: a section's new text
// replaced by the old one, with nothing to read it again for 20 s).
let overviewAsked = 0, overviewTaken = 0;
async function overview() {
  const n = ++overviewAsked, r = await window.p9.mission('overview');
  if (n < overviewTaken) return null;
  overviewTaken = n; return r;
}
async function loadMission() {
  if (!window.p9?.mission) return;
  const r = await overview();
  if (!r) return; // a newer answer was already drawn
  if (r.status !== 200) {
    const why = r.body?.error || r.status;
    if (outer.sampleView) outer.live.note = 'Sample data: the P9 daemon did not answer (' + why + ')';
    else if (why === 'settings-missing' || why === 'settings-invalid') outer.live.note = 'Mission Control is not set up yet (' + why + '): see Set up P9.';
    // A file the settings name is missing: which one, so the fix is one path in settings.json (finding 5). Retried, as the
    // settings and the files load live.
    else if (why === 'file-not-found') outer.live.note = 'Mission Control cannot find its ' + r.body.setting + ' file, ' + r.body.file + '. Fix that path in P9\'s settings file or create the file; trying again every 5 seconds.';
    else outer.live.note = 'P9\'s background service is not answering (' + why + '). Trying again every 5 seconds.';
    outer.live.noteRestart = !outer.sampleView && why !== 'settings-missing' && why !== 'settings-invalid';
    if (outer.live.noteRestart && !outer.lifetime.signal.aborted) outer.setTimeout(loadMission, 5000);
    return outer.renderMission();
  }
  applyOverview(r.body);
  outer.renderMission(); outer.renderTabs(); loadArt(); loadSprint();
}
// Sprint tracker: the button shows while the connected machine has a sprint status file (the sprint skill writes it each
// wake-up), or while a folder sprint's change waits to be applied (O233: a P9 sprint writes no status file). 404 = no sprint;
// any other answer keeps the button and the window says why.
async function loadSprint() {
  clearTimeout(outer.SP.timer);
  const [r, c] = await Promise.all([window.p9.mission('sprint').catch(() => ({ status: 503 })), window.p9.mission('sprintCopies').catch(() => ({ status: 503 }))]);
  if (outer.lifetime.signal.aborted) return;
  const on = r.status !== 404 && r.status !== 503, before = JSON.stringify([outer.SP.on, outer.SP.data, outer.SP.waiting]);
  outer.SP.on = on; outer.SP.data = r.status === 200 ? r.body : null; outer.SP.error = on && r.status !== 200 ? (r.body?.reason || r.body?.error || String(r.status)) : '';
  outer.SP.waiting = c.status === 200 && Array.isArray(c.body?.copies) ? c.body.copies.filter(x => !x.applied).length : 0;
  if (before !== JSON.stringify([outer.SP.on, outer.SP.data, outer.SP.waiting])) outer.renderMission(); // the tile shows merged/total or what waits
  if (outer.mdl.open && outer.S.modal?.kind === 'sprint') { if (on || outer.SP.waiting) outer.renderModal(); else outer.closeModal(); }
  outer.SP.timer = outer.setTimeout(loadSprint, 30000);
}
// The unnamed tile's buttons: each is a registry script (asks first, like any script), found by its fixed id.
const SPRINT_SCRIPTS = [['sprint-start', 'Sprint start'], ['sprint-close', 'Sprint close'], ['sprint-heavy', 'Heavy services']];
const scriptById = id => outer.M.cardScripts?.[id] ?? Object.values(outer.M.scripts).flat().find(s => s[0] === id && s[6]?.live);
// W-M: a sprint tile a section names runs that section's buttons and script refs, and only those (none: Open tmux alone); the
// fixed ids above are only the unnamed tile's, which no file asked for.
const sprintScripts = sec => { const sp = spaceOf(sec);
  return sp ? [...(outer.M.scripts[sec] || []), ...(sp.refs || []).filter(r => r.kind === 'scripts').map(r => scriptById(r.id)).filter(Boolean)].map(r => [r[0], r[1], r])
    : SPRINT_SCRIPTS.map(([id, label]) => [id, label, scriptById(id)]); };
async function loadArt() {
  const r = await window.p9.mission('icons').catch(() => null);
  if (r?.status !== 200 || outer.lifetime.signal.aborted) return;
  const key = JSON.stringify(r.body); if (key === outer.lastArt) return; outer.lastArt = key;
  outer.M.art = r.body; outer.renderMission();
}
// Everything one overview carries, so the first load, an answer, a finished turn and the poll below show the same thing.
function applyOverview(o) {
  outer.live.on = true; outer.live.note = ''; outer.live.noteRestart = false; outer.live.restart = o.restart; outer.live.settingsError = o.settingsError; outer.live.primary = o.primary; outer.live.waitDir = o.waiting; outer.dataNote(); outer.live.waiting = o.waiting?.split('/').pop() ?? null; // no waiting folder on a fresh install
  outer.M.scripts = {}; outer.M.cardScripts = {}; outer.M.title = {}; // hidden: a card's feeder or title-bar button, not a row
  // W-C: a group's key is its section's id (titles may repeat; M.title says what each key is called). A space button names its
  // section; a registry group named like a section joins the first one with that title; any other is 'g:' + its name (an id has no ':').
  const named = {}; for (const s of o.space || []) { named[s.title] ??= s.id; outer.M.title[s.id] = s.title; }
  // O237: the daemon keeps each script's last run, so every poll, device and restart shows the same one.
  for (const x of o.scripts) { const L = x.last, row = [x.id, x.title, x.desc, !L ? 'idle' : L.terminal || L.code === 0 ? 'ok' : 'bad',
    L ? new Date(L.at).toLocaleString() + (L.terminal ? ', opened in a terminal' : ', exit ' + L.code) : 'not run here yet',
    L && !L.terminal ? L.secs + ' s' : '', { args: x.args, confirm: x.confirm, terminal: x.terminal, live: true, tail: L?.tail, at: L?.at }];
    const name = x.group || 'Other', key = x.section ?? named[name] ?? 'g:' + name; outer.M.title[key] ??= name;
    if (x.hidden) outer.M.cardScripts[x.id] = row; else (outer.M.scripts[key] ||= []).push(row); }
  outer.M.buttons = o.scripts.map(x => ({ id: x.id, title: x.title, icon: x.icon, section: x.section })); // the editor's button rows (W-N)
  outer.M.apps = o.apps.map(a => [a.title, a.desc, a.terminal, a.id, a.icon]);
  outer.M.pages = o.pages.map(x => [x.title, x.url, x.id, x.icon]);
  // The free-form space: each section is a tile, even one with no buttons yet; its buttons arrived in o.scripts.
  outer.M.space = o.space || []; outer.M.icmFiles = !!o.icmFiles;
  outer.live.empty = Boolean(o.empty); outer.live.fileProtection = o.fileProtection === true; outer.live.spaces = o.spaces || []; outer.live.spaceName = o.spaceName ?? null; outer.live.mainFile = o.mainFile === true;
  for (const s of outer.M.space) if (!s.widget) outer.M.scripts[s.id] ||= []; // a widget section is its panel or built-in tile, not a group tile
  applyQueue(o);
}
// now: read it whatever is in front (a finished turn or run, queueSoon); the regular poll reads only while Mission is shown.
async function refreshMission(now) {
  if (!outer.live.on || !now && (document.hidden || outer.S.focus !== 'mission') || outer.lifetime.signal.aborted) return;
  const r = await overview().catch(() => null);
  if (r?.status !== 200 || outer.lifetime.signal.aborted) return;
  loadArt(); // a site's icon can arrive or age out with no change to the overview
  const key = JSON.stringify(r.body); if (key === outer.lastOverview) return; outer.lastOverview = key;
  applyOverview(r.body); outer.renderMission(); outer.renderTabs();
  if (outer.S.modal?.kind === 'scripts' && !outer.M.scripts[outer.S.modal.g]) outer.closeModal(); // its group is gone
  else if (['scripts', 'script', 'win', 'reviews', 'center'].includes(outer.S.modal?.kind)) outer.renderModal(); // script: a run another device finished (O237)
}
const pollMission = () => { refreshMission(); outer.setTimeout(pollMission, 20000); };
const queueSoon = () => { clearTimeout(outer.queueTimer); outer.queueTimer = outer.setTimeout(() => refreshMission(1), 500); }; // #489: the poll's own read, once (bytes)
function applyQueue(o) {
  const drafts = Object.fromEntries(outer.S.reviews.filter(x => x.live).map(x => [x.name, x]));
  const kept = outer.S.reviews.filter(x => x.live && x.draft && x.draft.trim() && !o.queue.some(q => q.name === x.name));
  outer.S.reviews = o.queue.map(q => { const file = outer.live.waiting + '/' + q.name; if (outer.S.docs[file]?.saved !== q.content) outer.S.docs[file] = { text: q.content, saved: q.content, sel: [0, 0], top: 0 };
    return { proj: q.project, kind: outer.needsLabel(), txt: q.title, file, age: q.age, updated: q.updated, name: q.name, hash: q.hash, live: true, draft: drafts[q.name]?.draft, sel: drafts[q.name]?.sel }; });
  // ponytail: "already waiting" means present at the first load, so a reload also quiets items a chat made before it.
  if (!outer.S.queueSeen) { outer.S.queueSeen = true; for (const r of outer.S.reviews) outer.S.quiet.add(r.file); }
  // Someone else answered (or removed) an item Builder was writing: keep his text visible, marked, so nothing is lost.
  for (const x of kept) outer.S.reviews.push({ ...x, gone: true, txt: x.txt.replace(/^(?:\(answered elsewhere\) )?/, '(answered elsewhere) ') });

  outer.reviewSort();
}
// P9's own notifications only (the old hub's silent jobs are a space data tile now).
const noticeLine = () => 'No notifications.';
// A category's rows: its scripts, plus a space section's notes, log views, folder lists and references.
const listRow = (i, a, b, c) => `<li><button data-i="${esc(i)}">${a}<span class="truncate">${b}</span><span class="sub truncate">${c}</span></button></li>`;
// A group's title, and its space section (none for a registry-only group); sample mode keys groups by title and has no space.
const gTitle = g => outer.M.title?.[g] ?? g, spaceOf = g => (outer.M.space || []).find(x => x.id === g);
const sectionRows = (g, l) => { const sp = spaceOf(g); return l.length + (sp ? (sp.notes ? 1 : 0) + sp.logs.length + (sp.folders?.length || 0) + (sp.refs?.length || 0) + (sp.data?.length || 0) + (sp.cards?.length || 0) + (sp.links?.length || 0) + (sp.checklists?.length || 0) : 0); };
const ago = min => min < 60 ? min + ' min' : min < 2880 ? Math.round(min / 60) + ' h' : Math.round(min / 1440) + ' d';
async function answerLive(r) {
  if (r.gone) return outer.toast({ kind: 'not saved', txt: r.file + ' was answered or removed elsewhere. Copy your text from the box; nothing was written.', level: 'warn' }, true);
  const answer = (r.draft || '').split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  if (!answer) return outer.toast({ kind: 'not saved', txt: 'Write an answer first.', level: 'warn' }, true);
  const res = await window.p9.mission('answer', { name: r.name, hash: r.hash, answer });
  if (res.status === 200) { outer.toast({ kind: 'saved', txt: 'Answer saved to ' + r.file, level: 'ok' }, true); r.draft = ''; }
  // Builder, 2026-10-21: an item with Q1:/Q2: lines and no A. line said "changed on disk" for days, so he kept retrying
  else if (res.body?.error === 'no-empty-answer-line') outer.toast({ kind: 'not saved', txt: r.file + ' has no empty A. line, so P9 cannot write your answer. Ask an agent to add one; your answer is still here.', level: 'bad' }, true);
  else if (res.status === 409) outer.toast({ kind: 'not saved', txt: r.file + ' changed on disk since you opened it. Reloaded it; your answer is still here.', level: 'warn' }, true);
  else outer.toast({ kind: 'not saved', txt: 'Could not save to ' + r.file + ': ' + outer.saveWhy(res) + '. Your answer is still here.', level: 'bad' }, true);
  await loadMission();
  if (outer.S.modal?.kind === 'review') { if (outer.S.reviews.length) outer.renderModal(); else outer.closeModal(); }
}
async function runLive(m, id) {
  const res = await window.p9.mission('run', { id, args: m.args, ...(m.armedRun ? { confirm: true } : {}) });
  if (res.status === 200 && res.body.launched) { m.out = ['Opened in a terminal.']; queueSoon(); return outer.S.modal === m && outer.renderModal(); }
  if (res.status !== 202) { m.out = ['Refused: ' + (res.body?.reason || res.body?.error || res.status)]; return outer.S.modal === m && outer.renderModal(); }
  let text = '', from = 0; m.running = true;
  for (;;) {
    const o = await window.p9.mission('output', { run: res.body.run, from });
    if (o.status !== 200) { m.out = [text, '[lost the run: ' + (o.body?.error || o.status) + ']']; break; }
    text += o.body.output; from = o.body.next; m.out = text.split('\n'); m.outAt = o.body.at;
    if (outer.S.modal === m) outer.renderModal();
    if (o.body.done) break;
    await new Promise(done => outer.setTimeout(done, 300));
  }
  m.running = false; if (outer.S.modal === m) outer.renderModal();
  queueSoon(); // the overview now carries this run as the script's last run (O237)
}
// Fresh-install finding 3a: a panel shows where a space section names it (the ICM template adds all four). Where no section
// names any, an existing install whose settings name a registry or waiting folder keeps all four, read only: no file is
// written. A fresh install has neither, so it gets none.
// A section names a panel with widget (the section is the panel) or widgets (the panel sits inside the section, W-I).
// idea, sprint and edit are P9's built-in tiles (W-D), not panels: naming one decides the top row's tiles, not the panels.
const TILE_WIDGETS = WIDGETS.filter(w => w.tile).map(w => w.id), panelW = w => !TILE_WIDGETS.includes(w);
const namesPanel = s => (s.widget && panelW(s.widget)) || s.widgets?.some(panelW);
const namesTile = () => (outer.M.space || []).some(s => TILE_WIDGETS.includes(s.widget) || s.widgets?.some(w => !panelW(w)));
const widgetOn = w => outer.sampleView || outer.M.space.some(s => s.widget === w || s.widgets?.includes(w)) || (outer.M.icmFiles && !outer.M.space.some(namesPanel));
// + New idea writes to the workspace's _ideas folder (an ICM file), so it follows the same rule as the widgets (finding 3b).
const icmSpace = () => outer.sampleView || outer.M.space.some(namesPanel) || outer.M.icmFiles && !outer.M.space.some(namesPanel);
const allNotes = () => outer.S.alerts;
// O190: what the token totals count, in the daemon's words (/usage tokens, ledger.mjs TOKENS); an older daemon sends none.
const tokensSay = () => usage.tokens ? `<p class="sm" data-tokens>Tokens counted: ${esc(usage.tokens)}</p>` : '';
const limitsBody = () => (usage.limits ? outer.usageRows() + `<ul class="plist" data-limits>${limitItems(usage.limits, outer.names)}</ul>` : '')
  + (usage.state === 'unavailable' ? '<p class="empty">No chat token records yet.</p>'
  : `<div class="stats"><div><span>Input tokens</span><b>${usage.totals.inputTokens.toLocaleString()}</b></div><div><span>Output tokens</span><b>${usage.totals.outputTokens.toLocaleString()}</b></div><div><span>Recorded cost</span><b>$${usage.totals.costUsd.toFixed(4)}</b></div></div>${tokensSay()}<p class="sm ${usage.state === 'stale' ? 'muted' : ''}">${usage.state === 'stale' ? 'Stale · ' : ''}${usage.samples} samples · ${usage.discarded} malformed discarded</p>`)
  + profileLines(usage);
// A3 (2): the Usage window's tabs. Limits is the plan windows above; Tokens and Cost read /usage/turns through
// p9.usageTurns(days) and are drawn by usage-history.mjs, loaded the first time either opens (the phone draws the same, phone.ts
// loadUsage). An older desktop has no p9.usageTurns and keeps Limits alone, as does any while the daemon's telemetry-tab pref
// is off (Settings > General, A3 (3)). The tab is kept on the window's modal, so each opening starts on Limits (the
// pace bars); the range and breakdown are kept for the session. The answer is read again when the range changes, each
// minute while Tokens or Cost is open, and 5 s after a 'rebuilding' answer (the daemon's first replay).
const UH = { days: 7, by: 'model', page: null, at: 0, busy: false, draw: null, load: null };
const UTABS = [['limits', 'Limits'], ['tokens', 'Tokens'], ['cost', 'Cost']];
const usageOpen = () => outer.S.modal?.kind === 'win' && outer.S.modal.id === 'musage', redrawUsage = () => { if (usageOpen()) outer.renderModal(); };
function readTurns() {
  const days = UH.days; UH.busy = true;
  window.p9.usageTurns(days).catch(() => null).then(r => {
    // 404: a daemon older than the route (a remote not yet updated); it is not read again on a timer.
    UH.busy = false; UH.page = r?.status === 200 && typeof r.body?.state === 'string' ? { ...r.body, days } : { state: r?.status === 404 ? 'unsupported' : 'unavailable', days }; UH.at = Date.now();
    // The next read: a redraw when this answer is stale, which reads again only if Tokens or Cost is still on screen.
    const soon = UH.page.state === 'rebuilding';
    if (UH.page.state !== 'unsupported') outer.setTimeout(() => { if (soon) UH.at = 0; redrawUsage(); }, soon ? 5000 : 60500);
    redrawUsage();
  });
}
function turnsBody(tab) {
  // An older daemon's 404 holds for every range: it is asked again only once the answer is a minute old.
  const stale = Date.now() - UH.at > 60000;
  if (!UH.busy && (stale || (UH.page?.days !== UH.days && UH.page?.state !== 'unsupported'))) readTurns();
  // A failed load (an update replaced the files under a running page, so the old file name is gone) offers a reload,
  // which reads the new names; no retry at each redraw.
  if (!UH.draw && !UH.failed) UH.load ??= import('./usage-history.mjs').then(m => { UH.draw = m.historyHtml; redrawUsage(); }, () => { UH.load = null; UH.failed = true; redrawUsage(); });
  return UH.draw ? UH.draw({ ...UH, tab }, esc, outer.names) : UH.failed
    ? '<p class="empty">This view could not load. P9 may have been updated. <button type="button" data-slot="button" data-variant="outline" data-size="sm" data-uh-reload>Reload the window</button></p>'
    : '<p class="sm muted">Loading…</p>';
}
const usageBody = (tab = outer.S.modal?.utab ?? 'limits') => !window.p9?.usageTurns || usage.telemetryTab === false ? limitsBody() : `<div class="cf-tabs" role="tablist" aria-label="Usage views">${UTABS.map(([id, label]) => `<button type="button" role="tab" id="utab-${id}" aria-controls="upanel" tabindex="${tab === id ? 0 : -1}" data-slot="button" data-variant="ghost" data-size="sm" data-utab="${id}" aria-selected="${tab === id}">${label}</button>`).join('')}</div>`
  + `<div id="upanel" role="tabpanel" aria-labelledby="utab-${tab}">${tab === 'limits' ? limitsBody() : turnsBody(tab)}</div>`;
// Arrow keys, Home and End move between the tabs and open the one reached (the tablist pattern).
function usageTabKey(e) {
  const ids = UTABS.map(([id]) => id), at = ids.indexOf(e.currentTarget.dataset.utab);
  const to = { ArrowRight: at + 1, ArrowLeft: at - 1 + ids.length, Home: 0, End: ids.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault(); outer.S.modal.utab = ids[to % ids.length]; outer.renderModal();
  document.getElementById('utab-' + outer.S.modal.utab)?.focus();
}
// Icon order: P9's own icon for P9; else the user's picture, the emoji or text icon, the automatic icon (a site's, a program's), the letters.
// shown: {picture, auto} as data: URIs from the daemon, shown only through <img>.
const art = (kind, key) => outer.M.art?.[kind]?.[key] || {};
const launchTile = (name, title, data, id, page, icon, shown = {}) => `<button class="ltile" data-launch="${esc(name)}" ${data} title="${esc(title)}">${id === 'p9' ? '<img src="/p9-icon.png" alt="">' : shown.picture || (!icon && shown.auto) ? `<img src="${esc(shown.picture || shown.auto)}" alt="">` : `<span class="mono-ico"${tint(name)}${icon ? ' data-icon' : ''}>${esc(icon || name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?')}</span>`}<span class="nm">${esc(name)}${page ? ' ↗' : ''}</span></button>`;
const winTop = {};
const winCard = id => { const w = outer.wins[id], [big, line, lvl] = w.card();
  return `<button class="win${lvl === 'bad' ? ' bad fx-halo' : ''}" data-win="${id}"><h4><span class="lvl" data-l="${lvl}"></span>${esc(w.title())}</h4><b class="big${id === 'mprimary' ? ' fx-title' : ''}">${esc(big)}</b><span class="line">${esc(line)}</span></button>`; };
// Usage and Apps sit open on the page and scroll on their own, like Waiting on you; the heading still
// opens the full window.
const PANELS = ['musage', 'mlaunch'];
const winPanel = id => `<section class="mpanel" data-panel="${id}"><button class="phead" data-win="${id}"><h4>${esc(outer.wins[id].title())}</h4><span>Open</span></button><div class="pscroll"></div></section>`;
const NEEDS = '<section class="needs" aria-label="Waiting on you"><div class="nhead"><h4>Waiting on you</h4><select data-slot="select" aria-label="Sort" data-sort><option value="updated">Newest</option><option value="project">Project</option></select></div><div class="bignum"><b data-n></b><span data-unit></span></div><div data-list></div></section>';
// The page from the space file: once any section has place col1 to col6, the columns hold the sections placed in them, in file
// order, and nothing else; every other section is a tile in the top row. With none placed, the page is the fixed layout below
// (waiting, Main project and Logs, then Usage, Apps and the cards), each box in the file order of the section naming it (W-H).
const PLACED = /^col[1-6]$/;
const placed = () => (outer.M.space || []).some(s => PLACED.test(s.place));
// W-G: as many columns as the highest one used (three at least, as before). A column's width is the largest span of its sections;
// while no section has span and only col1 to col3 are used, the columns keep the CSS widths they always had (no data-w).
const placedCols = () => { const used = outer.M.space.filter(s => PLACED.test(s.place)), n = Math.max(3, ...used.map(s => +s.place.slice(3))),
  own = n > 3 || used.some(s => Number.isInteger(s.span));
  return Array.from({ length: n }, (_, i) => { const mine = used.filter(s => s.place === 'col' + (i + 1));
    return { n: i + 1, mine, w: own ? Math.max(1, ...mine.map(s => Number.isInteger(s.span) && s.span >= 1 && s.span <= 6 ? s.span : 1)) : null }; }); };
const WIDGET_WIN = { usage: 'musage', apps: 'mlaunch', notifications: 'mnotes', primary: 'mprimary' };
// A widget draws P9's own panel; any other section draws open: its title and Open (its window), its items under it.
// data-sec and data-group carry the title; data-key, the section's id, is what a click and a redraw use (W-C).
const placedHtml = s => s.widget === 'waiting' ? NEEDS : s.widget === 'usage' || s.widget === 'apps' ? winPanel(WIDGET_WIN[s.widget])
  : TILE_WIDGETS.includes(s.widget) ? builtinTile(s.widget, s)
  : s.widget ? `<div data-card="${WIDGET_WIN[s.widget]}"></div>`
  : `<section class="mpanel" data-sec="${esc(s.title)}" data-key="${esc(s.id)}"><button class="phead" data-group="${esc(s.title)}" data-key="${esc(s.id)}"><h4>${esc(s.title)}</h4><span>Open</span></button><div class="pscroll"></div></section>`;
// P9's built-in tiles (W-D). Named by a section (s), each draws there under the section's title; idea shows because the file asks for it,
// sprint only while there is a sprint status file or a folder sprint's change waiting (O233). Unnamed, the three keep their own titles and today's rules.
const BUILTIN = Object.fromEntries(WIDGETS.filter(w => w.tile).map(w => [w.id, w.label])); // packages/protocol WIDGETS (CAT-2)
const builtinTile = (w, s) => !outer.live.on || (w === 'idea' && !s && !icmSpace()) || (w === 'sprint' && !outer.SP.on && !outer.SP.waiting) ? ''
  : w === 'idea' ? `<button class="tile" data-idea><span></span><b>${esc(s?.title ?? BUILTIN.idea)}</b></button>`
  : w === 'sprint' ? `<button class="tile" data-sprint="${esc(s?.id ?? '')}"><span class="lvl" data-l="${outer.SP.data || !outer.SP.on ? 'ok' : 'bad'}"></span><b>${esc(s?.title ?? BUILTIN.sprint)}</b><span class="n">${outer.SP.data ? outer.SP.data.chunks.filter(c => c.state === 'merged').length + '/' + outer.SP.data.chunks.length : outer.SP.on ? '!' : outer.SP.waiting + ' to apply'}</span></button>`
  : `<button class="tile" data-medit><span></span><b>${esc(s?.title ?? BUILTIN.edit)}</b></button>`;
// What a built-in tile (or its button inside a section's widgets) opens; sec is the section naming sprint, whose buttons its window runs.
const builtinModal = (w, sec) => w === 'idea' ? { kind: 'idea', name: '', text: '', needs: false } : w === 'sprint' ? { kind: 'sprint', sec } : { kind: 'medit', items: editItems(outer.M) };
// A group's top-row tile: g is its M.scripts key, l its rows.
const groupTile = (g, l) => { const sp = spaceOf(g), a = art('sections', g);
  return `<button class="tile${secWorst(g, l) === 'bad' ? ' bad fx-halo' : ''}" data-group="${esc(gTitle(g))}" data-key="${esc(g)}"><span class="lvl" data-l="${secWorst(g, l)}"></span><b>${a.picture ? `<img class="sec-ico" src="${esc(a.picture)}" alt=""> ` : ''}${!a.picture && sp?.icon ? `<span data-icon>${esc(sp.icon)}</span> ` : ''}${esc(gTitle(g))}</b><span class="n">${sectionRows(g, l)}</span></button>`; };
// The top row (W-D): registry-only groups, then the sections in file order (one placed in a column is drawn there), each as its group
// tile, its panel's tile (the placed layout) or its built-in tile. Where no section names a built-in tile, the three end the row as before.
const topRow = lay => Object.entries(outer.M.scripts).filter(([g]) => !spaceOf(g)).map(([g, l]) => groupTile(g, l)).join('')
  + (outer.M.space || []).filter(s => !lay || !PLACED.test(s.place)).map(s => (TILE_WIDGETS.includes(s.widget) ? builtinTile(s.widget, s) : s.widget && lay ? widgetTile(s) : '')
    // A widget section's own buttons keep their tile, as before; a sprint section's are its window's buttons (W-M).
    + (outer.M.scripts[s.id] && s.widget !== 'sprint' ? groupTile(s.id, outer.M.scripts[s.id]) : '')).join('')
  + (namesTile() ? '' : TILE_WIDGETS.map(w => builtinTile(w)).join(''));
// W-H: with nothing placed, the fixed layout's boxes keep their columns, but within one they follow the file order of the sections
// naming them (a box none names keeps its place after those). A space naming none draws exactly the old layout.
const fileRank = w => { const i = (outer.M.space || []).findIndex(s => s.widget === w || s.widgets?.includes(w)); return i < 0 ? Infinity : i; };
const byFile = boxes => boxes.map((b, i) => [b, i]).sort((x, y) => fileRank(x[0][0]) - fileRank(y[0][0]) || x[1] - y[1]).map(([b]) => b[1]).join('');
// In the placed layout a widget section left in the top row is a tile that opens its window.
const widgetTile = s => { const id = WIDGET_WIN[s.widget], w = outer.wins[id];
  if (s.widget !== 'waiting' && w.show && !w.show()) return '';
  const [big, , lvl] = s.widget === 'waiting' ? [outer.S.reviews.length, '', outer.S.reviews.length ? 'warn' : 'ok'] : w.card();
  return `<button class="tile" data-wtile="${id || 'waiting'}"><span class="lvl" data-l="${lvl}"></span><b>${esc(s.title)}</b><span class="n">${esc(big)}</span></button>`; };
const secPanel = g => [...document.querySelectorAll('#fMission [data-sec]')].find(p => p.dataset.key === g);
// A placed section's state (tile answers, card HTML, counts, a quick note's text), kept while its space entry is unchanged.
const inlineSec = {};
// On the page a redraw writes only changed markup; a field being typed in keeps its focus and caret across it.
const writeKeep = (el, html) => {
  if (outer.written.get(el) === html) return false;
  const a = document.activeElement, name = el.contains(a) && a.name, at = name && [a.selectionStart, a.selectionEnd];
  outer.setHTML(el, html);
  const n = name && el.querySelector(`[name="${CSS.escape(name)}"]`);
  if (n) { n.focus(); if (at[0] != null) n.setSelectionRange(at[0], at[1]); }
  return true;
};
function secInline(g) {
  const p = secPanel(g), sp = spaceOf(g);
  if (!p || !sp || !outer.M.scripts[g]) return;
  const key = JSON.stringify(sp);
  let m = inlineSec[g];
  if (m?.key !== key) { if (m) clearInterval(m.pulling); m = inlineSec[g] = { key }; }
  // ponytail: a counted folder and a checklist are read once per version of the section here, not on each look as the window does.
  sectionBody(m, p.querySelector('.pscroll'), g, { write: writeKeep, shown: () => inlineSec[g] === m && !!secPanel(g),
    seen: () => outer.S.focus === 'mission' && !document.hidden, redraw: () => secInline(g) });
  p.dataset.l = secLv[g] || '';
}
// D9: an empty Mission (no buttons, apps, pages or waiting items yet) says what it is and how to set it up.
const missionEmpty = () => window.p9?.mission && !outer.sampleView && !Object.keys(outer.M.scripts).length && !outer.M.apps.length && !outer.M.pages.length && !outer.S.reviews.length
  && (outer.live.on || /not set up/.test(outer.live.note));
const missionIntro = () => '<div class="sm" data-mission-intro role="note"><h4>What is Mission Control?</h4>'
  + '<p>Your control room: one place for the buttons that run your scripts, shortcuts to your apps and pages, and a list of what is waiting on you.</p>'
  + '<p class="muted">It reads three things from your workspace: a main project file, a file of buttons, apps and pages, and a folder with one .md file for each item waiting on you. Settings → Mission Control files points P9 at the ones you already have.</p>'
  + '<div class="set-row">' + (window.p9?.openDocs ? '<button data-slot="button" data-variant="outline" data-mission-docs>How to add buttons</button>' : '') + '</div></div>';
async function loadGuide() {
  const r = await window.p9.mission('guide', {});
  if (r.status !== 200) return;
  outer.guide = r.body;
  if (outer.live.empty || outer.live.adding) outer.renderMission();
  if (outer.mdl.open && outer.S.modal?.kind === 'guide') outer.renderModal();
}
function renderSpaceBtn() {
  const b = outer.$('#spaceBtn'), pop = outer.$('#spacePop');
  b.hidden = !outer.live.on;
  b.dataset.spaceCurrent = outer.live.spaceName || '';
  b.innerHTML = esc(outer.live.spaceName || 'Main') + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  b.title = 'The space Mission Control shows. Click to switch spaces or add one.';
  outer.spacePop ??= outer.popover(b, pop, () => { pop.style.left = Math.max(8, Math.min(b.offsetLeft, innerWidth - pop.offsetWidth - 8)) + 'px'; outer.spaceForm = null; renderSpaceMenu(); refreshMission(); });
  if (!pop.hidden && !outer.spaceForm) renderSpaceMenu(true);
}
function renderSpaceMenu(redraw) {
  const pop = outer.$('#spacePop'), now = outer.live.spaceName || '';
  const html = '<div class="hd eyebrow">Space</div>' + ['', ...(outer.live.spaces || [])].map(n => `<button class="item" role="menuitemradio" aria-checked="${n === now}" data-space="${esc(n)}">${esc(n || 'Main')}</button>`).join('')
    + '<hr data-slot="separator" style="margin:6px 0"><button class="item" role="menuitem" data-space-add>+ Add</button><button class="item" role="menuitem" data-space-save>Save as template…</button>'
    + (now ? `<button class="item space-del" role="menuitem" data-space-del>Delete ${esc(now)}…</button>` : '');
  // A poll's redraw of the open menu with nothing new keeps its buttons: a fresh node under the pointer eats the click (M4a in CI).
  if (redraw && html === outer.spaceMenuHtml && !pop.querySelector('.space-form')) return;
  outer.spaceMenuHtml = html;
  pop.innerHTML = html;
  pop.querySelector('[data-space-save]').onclick = () => spaceSave();
  pop.querySelector('[data-space-del]')?.addEventListener('click', spaceDelete);
  pop.querySelectorAll('[data-space]').forEach(b => b.onclick = async () => {
    outer.spacePop.close(); outer.live.adding = false; outer.live.preview = null;
    const r = await window.p9.mission('space', { name: b.dataset.space || null });
    if (r.status !== 200) outer.toast({ kind: 'not saved', txt: 'Space: ' + (r.body?.error || r.status), level: 'bad' }, true);
    refreshMission();
  });
  pop.querySelector('[data-space-add]').onclick = () => { outer.spacePop.close(); outer.live.adding = true; outer.live.preview = null; outer.renderMission(); };
}
// Finding 4 adds: Delete removes the shown space's file after a confirm that names it; the last space is kept and + Add offered.
const formGo = (...buttons) => '<div class="space-form-go">' + buttons.join('') + '</div>';
const formBtn = (variant, attr, label, type = 'button') => `<button type="${type}" data-slot="button" data-variant="${variant}" data-size="sm" ${attr}>${label}</button>`;
function spaceDelete() {
  const pop = outer.$('#spacePop'), name = outer.live.spaceName, last = !outer.live.mainFile && (outer.live.spaces || []).length <= 1;
  outer.spaceForm = 'delete';
  pop.innerHTML = last
    ? `<div class="space-form" data-space-confirm role="alertdialog" aria-labelledby="spaceDelHd"><p id="spaceDelHd"><b>${esc(name)}</b> is your only space, so P9 keeps it.</p><p class="muted">Add another space first.</p>`
      + formGo(formBtn('default', 'data-space-add', '+ Add'), formBtn('outline', 'data-space-cancel', 'Cancel')) + '</div>'
    : `<div class="space-form" data-space-confirm role="alertdialog" aria-labelledby="spaceDelHd"><p id="spaceDelHd">Delete <b>${esc(name)}</b>?</p><p class="muted">This removes its file. It can't be undone.</p><p class="muted" data-space-note role="status"></p>`
      + formGo(formBtn('destructive', 'data-space-del-go', 'Delete ' + esc(name)), formBtn('outline', 'data-space-cancel', 'Cancel')) + '</div>';
  bindSpaceForm(pop);
  const go = pop.querySelector('[data-space-del-go]');
  if (!go) return pop.querySelector('[data-space-add]').focus();
  go.focus();
  go.onclick = async () => {
    go.disabled = true;
    const r = await window.p9.mission('deleteSpace', { name, ...(go.dataset.armed ? { confirm: true } : {}) });
    go.disabled = false;
    if (r.status === 403 && !go.dataset.armed) { go.dataset.armed = '1'; pop.querySelector('[data-space-note]').textContent = 'File protection is on. Click Delete again to delete it.'; return; }
    if (r.status !== 200) { pop.querySelector('[data-space-note]').textContent = 'Not deleted: ' + (r.body?.detail || r.body?.error || r.status); return; }
    outer.spaceForm = null; outer.spacePop.close();
    outer.toast({ kind: 'saved', txt: 'Space ' + name + ' deleted.', level: 'ok' }, true);
    refreshMission();
  };
}
// Save as template: a name (the scratch-space rule) and an optional one-line about. A clash asks Replace or Rename.
function spaceSave() {
  const pop = outer.$('#spacePop');
  outer.spaceForm = 'save';
  pop.innerHTML = '<form class="space-form" data-space-save-form aria-labelledby="spaceSaveHd"><p id="spaceSaveHd"><b>Save as template</b></p>'
    + `<label>Name<input data-slot="input" name="name" required maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{0,31}" autocomplete="off" spellcheck="false" value="${esc(outer.live.spaceName || 'main')}"></label>`
    + '<span class="muted space-hint">Lowercase letters, digits and -</span>'
    + '<label><span>About <span class="muted">(optional)</span></span><input data-slot="input" name="about" maxlength="200" autocomplete="off"></label>'
    + '<p class="muted" data-space-note role="status"></p>'
    + '<div class="space-form-go" data-space-clash hidden>' + formBtn('default', 'data-space-replace', 'Replace') + formBtn('outline', 'data-space-rename', 'Rename') + '</div>'
    + formGo(formBtn('default', 'data-space-save-go', 'Save template', 'submit'), formBtn('outline', 'data-space-cancel', 'Cancel')) + '</form>';
  bindSpaceForm(pop);
  const form = pop.querySelector('form'), note = form.querySelector('[data-space-note]'), clash = form.querySelector('[data-space-clash]');
  form.elements.name.select();
  const save = async (replace) => {
    const name = form.elements.name.value.trim(), r = await window.p9.mission('saveTemplate', { name, about: form.elements.about.value.trim(), ...(replace ? { replace: true } : {}) });
    clash.hidden = r.body?.error !== 'template-exists';
    if (r.status === 201) {
      outer.spaceForm = null; outer.spacePop.close(); outer.guide = null; loadGuide();
      return outer.toast({ kind: 'saved', txt: 'Template ' + name + ' saved. It shows under + Add.', level: 'ok' }, true);
    }
    note.textContent = r.body?.error === 'template-exists' ? 'A template named ' + name + ' exists. Replace it, or rename this one.'
      : r.body?.error === 'builtin-template' ? name + ' is a built-in template. Pick another name.'
        : 'Not saved: ' + (r.body?.detail || r.body?.error || r.status);
  };
  form.onsubmit = (event) => { event.preventDefault(); save(false); };
  form.querySelector('[data-space-replace]').onclick = () => save(true);
  form.querySelector('[data-space-rename]').onclick = () => { clash.hidden = true; note.textContent = ''; form.elements.name.select(); };
}
function bindSpaceForm(pop) {
  pop.querySelectorAll('[data-space-cancel]').forEach((b) => b.onclick = () => { outer.spaceForm = null; renderSpaceMenu(); });
  pop.querySelector('[data-space-add]')?.addEventListener('click', () => { outer.spaceForm = null; outer.spacePop.close(); outer.live.adding = true; outer.live.preview = null; outer.renderMission(); });
}
function bindOnboard(root) {
  root.querySelectorAll('[data-build]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    // From + Add the build goes into a new space under a free name, never the one shown (threat model row 72). MC-17: from a
    // template preview the daemon adds the template to a new space first; File protection asks for a second click, as Choose does.
    const from = b.dataset.from, kept = from && outer.live.kept?.from === from ? outer.live.kept.space : 0;
    const space = kept || (from || outer.live.adding ? freeName(from || 'new-space', outer.live.spaces || []) : 0);
    const r = await window.p9.mission('build', { provider: b.dataset.build, ...(space ? { space } : {}), ...(from ? { template: from, confirm: !!b.dataset.armed } : {}) });
    b.disabled = false;
    if (r.status === 403 && !b.dataset.armed) { b.dataset.armed = '1'; root.querySelector('[data-onboard-note]').textContent = 'File protection is on. Click again to add the template.'; return; }
    // MC-17 fix 1: the space was added but its chat did not start: it shows in the Space menu, and a retry starts the chat there.
    // Fix 2: the daemon no longer holds that space for a retry (or it was deleted): a 409 drops it, so the next click builds anew.
    if (kept && r.status === 409) { outer.live.kept = null; outer.toast({ kind: 'chat', txt: 'Space ' + space + ' is kept as it is. Click ' + b.textContent + ' again to build into a new space.', level: 'bad' }, true); return; }
    if (r.body?.kept) { outer.live.kept = { from, space }; refreshMission(1); outer.toast({ kind: 'chat', txt: 'Space ' + space + ' added, but its chat did not start (' + (r.body.error || r.status) + '). Click ' + b.textContent + ' again to retry.', level: 'bad' }, true); return; }
    if (from && r.status === 201) { outer.live.kept = null; await window.p9.mission('space', { name: space }); }
    if (r.status === 201 && r.body.space) {
      outer.live.adding = false; outer.live.preview = null; from ? refreshMission() : outer.renderMission();
      outer.toast({ kind: 'chat', txt: (outer.names[b.dataset.build] ?? b.dataset.build) + ' builds the new space ' + r.body.space + '. It shows in the Space menu once it has a section.', level: 'ok' }, true);
    }
    if (r.status === 201) outer.openModal({ kind: 'chat', id: r.body.conversation });
    else outer.toast({ kind: 'chat', txt: b.textContent + ': ' + (r.body?.error || r.status), level: 'bad' }, true);
  });
  root.querySelectorAll('[data-yourself]').forEach(b => b.onclick = () => outer.openModal({ kind: 'guide' }));
  root.querySelectorAll('[data-open-protect]').forEach(b => b.onclick = async () => { await outer.$('#setBtn').onclick(); const input = outer.$('#setProtect'); input?.scrollIntoView({ block: 'center' }); input?.focus(); });
  root.querySelectorAll('[data-template]').forEach(b => b.onclick = () => { outer.live.preview = b.dataset.template; outer.renderMission(); });
  root.querySelectorAll('[data-preview-back]').forEach(b => b.onclick = () => { outer.live.preview = null; outer.renderMission(); });
  root.querySelectorAll('[data-add-cancel]').forEach(b => b.onclick = () => { outer.live.adding = false; outer.renderMission(); });
  // Choose: the template into a new scratch space under a free name (the route also refuses a space with sections), then shown.
  // File protection answers the first click 403 and arms the button; the second click sends the user's confirmation, as the edit form does.
  root.querySelectorAll('[data-choose]').forEach(b => b.onclick = async () => {
    const name = b.dataset.choose, note = root.querySelector('[data-onboard-note]');
    const space = freeName(name, outer.live.spaces || []);
    b.disabled = true;
    const r = await window.p9.mission('template', { name, space, ...(b.dataset.armed ? { confirm: true } : {}) });
    const shown = r.status === 201 && (await window.p9.mission('space', { name: space })).status === 200;
    b.disabled = false;
    if (r.status === 403 && !b.dataset.armed) { b.dataset.armed = '1'; note.textContent = 'File protection is on. Click Choose template again to add it.'; return; }
    outer.toast({ kind: r.status === 201 ? 'saved' : 'not saved', level: r.status === 201 ? 'ok' : 'bad',
      txt: r.status !== 201 ? templateWords(r.status, r.body) : shown ? 'Space ' + space + ' added. Rename and fill its sections.' : 'Space ' + space + ' added. Pick it in the Space menu.' }, true);
    if (r.status !== 201) return;
    outer.live.adding = false; outer.live.preview = null; refreshMission();
    // ponytail: the one template that needs a folder asks for it as it is added; a template field for this is out of scope.
    if (name === 'obsidian' && window.p9.pickVault) await pickVault();
  });
}
// The Obsidian vault folder (threat model row 73): desktop only. Main shows the native picker and a confirm, then tells the daemon.
// On a remote the vault is the remote's folder (finding 3b, answer A): the setup chat opens with the ask typed, not sent,
// and adds the folder with allow_folder once the user confirms there.
async function vaultChat() {
  const r = await window.p9.mission('build', { provider: outer.wizPicked()[0] || 'claude' });
  if (r.status !== 201) { outer.toast({ kind: 'chat', level: 'bad', txt: 'Setup chat not started (' + (r.body?.error || r.status) + ').' }, true); return false; }
  const id = r.body.conversation;
  outer.openModal({ kind: 'chat', id });
  for (let i = 0; i < 50 && !outer.S.sessions.some(s => s.id === id); i++) await new Promise(res => outer.setTimeout(res, 100));
  const s = outer.S.sessions.find(x => x.id === id);
  if (s && !s.draft) { s.draft = 'Add my Obsidian vault folder'; if (outer.S.modal?.id === id) outer.renderModal(); }
  outer.toast({ kind: 'chat', level: 'ok', txt: 'P9 runs on the remote, so the setup chat adds the folder there.' }, true);
  return false;
}
async function pickVault() {
  const r = await window.p9.pickVault();
  if (r.body?.canceled) return false;
  const ok = r.status === 201, e = r.body?.error;
  if (e === 'server-mode-local-only') return vaultChat();
  outer.toast({ kind: ok ? 'saved' : 'not saved', level: ok ? 'ok' : 'bad', txt: ok ? 'Vault folder set: ' + r.body.vault
      : e === 'name-taken' ? 'A vault folder is already set: ' + r.body.folder : e === 'root-refused' ? 'Mission does not use this folder: it holds the workspace, the home folder or P9\'s own files.'
        : 'Vault folder not set (' + (e || r.status) + ').' }, true);
  if (ok) refreshMission();
  return ok;
}
async function launchLive(name, req) {
  const res = await window.p9.mission('launch', req);
  outer.toast({ kind: res.status === 200 ? 'launched' : 'not launched', txt: name + (res.status === 200 ? '' : ' (' + (res.body?.reason || res.body?.error || res.status) + ')'), level: res.status === 200 ? 'ok' : 'bad' }, true);
}
// A section window's buttons; back returns to the window
function bindWin(root, m) {
  root.querySelectorAll('[data-utab],[data-uh-days],[data-uh-by]').forEach(b => b.onclick = () => {
    const d = b.dataset; if (d.utab) outer.S.modal.utab = d.utab; if (d.uhDays) UH.days = +d.uhDays; if (d.uhBy) UH.by = d.uhBy;
    outer.renderModal(); });
  root.querySelector('[data-uh-reload]')?.addEventListener('click', () => location.reload());
  root.querySelectorAll('[data-utab]').forEach(b => b.onkeydown = usageTabKey);
  root.querySelectorAll('[data-launch]').forEach(b => b.onclick = async () => {
    if (!outer.live.on) return outer.toast({ kind: 'launched', txt: b.dataset.launch + ' (mock: nothing opens)', level: 'ok' }, true);
    // A link that is not http(s) opens another program: the full link is shown first, and only Open sends confirm (M6).
    const page = b.dataset.page ? outer.M.pages[+b.dataset.page] : null;
    if (page && !/^https?:\/\//i.test(page[1])) return outer.openModal({ kind: 'link', page, back: m });
    launchLive(b.dataset.launch, b.dataset.page ? { kind: 'pages', id: page[2] } : { kind: 'apps', id: outer.M.apps[+b.dataset.app][3] });
  });
}
// The parts that change: the queue and notices are the same S.reviews and S.alerts the cards use. Redraws the
// section cards, and the open window's list in place (keeping its scroll).
function missionLive() {
  const page = outer.$('#fMission .mrow');
  if (page) {
    const box = page.querySelector('.wins'); // the fixed layout's cards
    if (box) outer.setHTML(box, Object.keys(outer.wins).filter(id => id !== 'mprimary' && !PANELS.includes(id) && (!outer.wins[id].show || outer.wins[id].show())).map(winCard).join(''));
    page.querySelectorAll(':scope>.mcol>[data-card]').forEach(c => { const id = c.dataset.card; outer.setHTML(c, !outer.wins[id].show || outer.wins[id].show() ? winCard(id) : ''); });
    page.querySelectorAll('[data-panel]').forEach(p => { const id = p.dataset.panel; p.hidden = !!outer.wins[id].show && !outer.wins[id].show(); p.querySelector('h4').textContent = outer.wins[id].title(); bindWin(outer.setHTML(p.querySelector('.pscroll'), (outer.wins[id].inline || outer.wins[id].body)()), { kind: 'win', id }); });
    page.querySelectorAll('[data-sec]').forEach(p => secInline(p.dataset.key));
    // With a space file the built-in layer is off, so Main project and Logs are gone: an empty column hides and the others widen.
    page.querySelectorAll('.mcol').forEach(col => { col.hidden = ![...col.children].some(k => !k.hidden && k.innerHTML.trim()); });
    if (page.dataset.placed !== undefined) {
      const shown = [...page.querySelectorAll(':scope>.mcol:not([hidden])')];
      page.dataset.cols = shown.length;
      // W-G: the columns shown share the row by their weights (a hidden one gives its share to the others).
      if (shown.some(col => col.dataset.w)) page.style.setProperty('--mcols', shown.map(col => `minmax(0,${col.dataset.w || 1}fr)`).join(' ')); else page.style.removeProperty('--mcols');
    }
    outer.$('#fMission').querySelectorAll('[data-win]').forEach(b => b.onclick = () => outer.openModal({ kind: 'win', id: b.dataset.win }));
  }
  const set = (id, html) => { const b = outer.$(`#mdl #${id} .pbody`); if (!b) return { querySelectorAll: () => [] }; return outer.setHTML(b, html); };
  const needs = outer.$('#fMission .needs [data-list]'); outer.$('#fMission .needs [data-n]')?.replaceChildren(String(outer.S.reviews.length)); outer.$('#fMission .needs [data-unit]')?.replaceChildren(outer.S.reviews.length === 1 ? ' item' : ' items');
  (needs ? outer.setHTML(needs, reviewList('data-i')) : { querySelectorAll: () => [] })
    .querySelectorAll('[data-i]').forEach(b => b.onclick = () => outer.openModal({ kind: 'review', i: +b.dataset.i }, 'reviews'));
  const notes = allNotes();
  set('mnotes', noteList(notes, 'data-i'))
    .querySelectorAll('[data-i]').forEach(b => b.onclick = () => outer.openModal({ kind: 'alert', a: notes[+b.dataset.i], back: outer.S.modal }));
  fillWidgets(outer.$('#fMission'));
  if (outer.S.modal?.kind === 'scripts' && outer.mdl.open) fillWidgets(outer.$('#mdlBody'), outer.S.modal);
}
// Waiting on you and Notifications as lists; at is the attribute each row's button carries (a section's widgets use their own, W-I).
// O181: the project (a waiting file's "**Project:** <name>" line) shows only when the file says one; with none, the age
// stands alone — never the file's own name, which used to show as a slug. proj is always a string ('' when the file says
// no project), so `proj && ' · '` renders the separator only with one.
const reviewList = at => outer.S.reviews.length ? `<ul class="plist">${outer.S.reviews.map((r, i) => `<li><button ${at}="${esc(i)}"><span class="kind"${tint(r.kind)}>${esc(r.kind)}</span><span class="sm"><span class="tint"${tint(r.proj)}>${esc(r.proj)}</span><span class="muted">${r.proj && ' · '}${esc(r.age)}</span></span><span class="txt">${esc(r.txt)}</span></button></li>`).join('')}</ul>` : '<p class="empty">Nothing waiting on you.</p>';
const noteList = (notes, at) => notes.length ? `<ul class="plist">${notes.map((a, i) => `<li><button ${at}="${esc(i)}"${a.level === 'bad' ? ' class="bad fx-halo"' : ''}><span class="lvl" data-l="${esc(a.level)}"></span><span class="kind"${tint(a.kind)}>${esc(a.kind)}</span><span class="txt">${esc(a.txt)}</span></button></li>`).join('')}</ul>` : `<p class="empty">${esc(noticeLine())}</p>`;
// A section's widgets (W-I): P9's own panels inside the section, on the page and in its window. sectionBody draws each empty and
// calls this; missionLive calls it again, so a new notification or waiting item shows where the section is. back: what a row returns to.
function fillWidgets(root, back) {
  root?.querySelectorAll('.wdg[data-widget]').forEach(box => {
    const w = box.dataset.widget, b = box.querySelector('.wbody'), notes = allNotes();
    outer.written.delete(b); // O152: a patched section keeps this node but empties it, so its last fill is no longer on screen
    if (w === 'notifications') outer.setHTML(b, noteList(notes, 'data-wnote')).querySelectorAll('[data-wnote]').forEach(x => x.onclick = () => outer.openModal({ kind: 'alert', a: notes[+x.dataset.wnote], back: back ?? outer.S.modal }));
    else if (w === 'waiting') outer.setHTML(b, reviewList('data-wreview')).querySelectorAll('[data-wreview]').forEach(x => x.onclick = () => outer.openModal({ kind: 'review', i: +x.dataset.wreview }, 'reviews'));
    else if (w === 'usage') outer.setHTML(b, outer.wins.musage.inline());
    else if (w === 'apps') bindWin(outer.setHTML(b, outer.wins.mlaunch.body()), back ?? { kind: 'win', id: 'mlaunch' });
    else if (w === 'primary') outer.setHTML(b, outer.live.primary ? outer.wins.mprimary.body() : '<p class="empty">No main project.</p>');
    else if (TILE_WIDGETS.includes(w)) outer.setHTML(b, w === 'sprint' && !outer.SP.on && !outer.SP.waiting ? '<p class="empty">No sprint status file.</p>' : `<button data-slot="button" data-variant="outline" data-wopen>${esc(BUILTIN[w])}</button>`)
      .querySelectorAll('[data-wopen]').forEach(x => x.onclick = () => outer.openModal(builtinModal(w, box.dataset.wkey)));
  });
}
// Notes (threat model row 34): a folder outside the workspace, named in settings.notes_roots; the daemon checks every path.
// The preview goes through md, which shows raw HTML as text and links and images as plain text (row 18).
const noteKey = (root, path) => 'notes:' + root + '/' + path;
const noteError = { exists: 'A note with that name already exists; nothing was changed.', 'no-such-folder': 'That folder does not exist; make it in your notes app first.',
  'request-refused': 'Use a .md name with no part starting with a dot.' };
function notesModal(m, body, row) {
  outer.$('#mdlT').textContent = m.title + ' · notes';
  if (m.list === undefined) { m.list = null; window.p9.mission('notes', { root: m.root }).then(r => { m.list = r.status === 200 ? r.body : { error: r.body?.error || String(r.status) }; if (outer.S.modal === m) outer.renderModal(); }); }
  const l = m.list, now = Date.now();
  body.innerHTML = !l ? '<p class="sm muted">Loading…</p>' : l.error ? `<p class="sm muted">Could not list the notes (${esc(l.error)})</p>`
    : `<div class="notes-new"><input data-slot="input" data-new value="${esc(m.draftName || '')}" placeholder="folder/new-note.md" aria-label="New note"><button data-slot="button" data-size="sm" data-create>New note</button></div>`
      + (l.files.length ? `<ul class="mlist">${l.files.map((f, i) => row(i, '<span class="kind">md</span>', esc(f.path), esc(ago(Math.max(0, Math.round((now - f.modified) / 60000)))) + ' ago')).join('')}</ul>` : '<p class="empty">No .md notes in this folder yet.</p>');
  outer.$('#mdlFoot').innerHTML = l && !l.error ? `<span class="muted sm" data-notes-count>${l.total > l.files.length ? `Showing the newest ${l.files.length} of ${l.total} notes` : `${l.total} note${l.total === 1 ? '' : 's'}`}${l.partial ? ' · a very big folder: some subfolders were not read' : ''}</span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="sm" data-reload>Reload</button>` : '';
  outer.$('#mdlFoot [data-reload]')?.addEventListener('click', () => { m.list = undefined; outer.renderModal(); });
  body.querySelectorAll('[data-i]').forEach(b => b.onclick = () => outer.openModal({ kind: 'note', root: m.root, path: l.files[+b.dataset.i].path, back: m }));
  const input = body.querySelector('[data-new]'); if (!input) return;
  input.oninput = () => { m.draftName = input.value; };
  const create = async () => {
    let p = (m.draftName || '').trim().replace(/^\/+/, '');
    if (!p) return outer.toast({ kind: 'not saved', txt: 'Type a name for the new note first.', level: 'warn' }, true);
    if (!/\.md$/i.test(p)) p += '.md';
    const r = await window.p9.mission('noteCreate', { root: m.root, path: p, content: '# ' + p.split('/').pop().replace(/\.md$/i, '') + '\n\n' });
    if (r.status === 201) { m.draftName = ''; m.list = undefined; outer.openModal({ kind: 'note', root: m.root, path: r.body.path, edit: true, back: m }); }
    else outer.toast({ kind: 'not saved', txt: p + ': ' + (noteError[r.body?.error] || 'could not create it (' + (r.body?.error || r.status) + ')'), level: 'warn' }, true);
  };
  body.querySelector('[data-create]').onclick = create;
  input.onkeydown = e => { if (e.key === 'Enter') create(); };
}
// A real file from the Chat Focus browser (threat model rows 23, 4, 7): the same editor as Dev Focus's fallback; Save is the one "save"
// action, the daemon's guarded PUT /files, so a changed file answers 409 and the draft stays (like a Mission note).
const liveKey = name => 'live:' + name;
function liveFileModal(m, body) {
  if (FILE_IMAGE.test(m.name)) return imageModal(m, body);
  const project = /^:project-files\/([0-9a-f-]{36})\/(.+)$/.exec(m.name);
  const key = liveKey(m.name);
  outer.$('#mdlT').textContent = project ? project[2] : m.name;
  if (!m.asked && !outer.dirty(key)) {
    m.asked = true;
    window.p9.mission(project ? 'projectRead' : 'read', project ? { project: project[1], path: project[2] } : { path: m.name }).then(r => {
      if (r.status === 200 && !outer.dirty(key)) outer.S.docs[key] = { text: r.body.content, saved: r.body.content, hash: r.body.hash, sel: [0, 0], top: 0 };
      else if (r.status !== 200) m.error = r.body?.error || String(r.status);
      if (outer.S.modal === m) outer.renderModal();
    }).catch(() => { m.error = 'daemon-unavailable'; if (outer.S.modal === m) outer.renderModal(); });
  }
  const d = outer.S.docs[key];
  if (!d) { body.innerHTML = `<p class="sm muted">${m.error ? 'Not readable: ' + esc(m.error) : 'Loading…'}</p>`; outer.$('#mdlFoot').innerHTML = `<span class="muted sm mono truncate">${esc(m.name)}</span>`; return; }
  const c = m.conflict;
  body.innerHTML = (c ? `<div class="review notes-conflict" data-conflict>${c.diskHash !== undefined
    ? `<p>Changed on disk since you opened it. Your text is still here.</p><div class="notes-row"><button data-slot="button" data-variant="outline" data-size="sm" data-disk>Load disk version</button><button data-slot="button" data-size="sm" data-mine>Save mine over it</button></div>`
    : `<p>This file is no longer on disk (moved, renamed or deleted elsewhere). Your text is still here: copy it before you close.</p><div class="notes-row"><button data-slot="button" data-size="sm" data-copytext>Copy my text</button></div>`}</div>` : '')
    + outer.editorHtml(key, 'mdlEd');
  if (project) { outer.edSave = null; body.querySelector('textarea').readOnly = true; outer.$('#mdlFoot').innerHTML = '<span class="muted sm">Read-only</span>'; return; }
  outer.wireEditor(body, key, () => liveFoot(m), () => saveLive(m));
  body.querySelector('[data-disk]')?.addEventListener('click', () => { Object.assign(d, { text: c.diskContent, saved: c.diskContent, hash: c.diskHash }); m.conflict = null; outer.renderModal(); });
  body.querySelector('[data-mine]')?.addEventListener('click', () => saveLive(m, c.diskHash));
  body.querySelector('[data-copytext]')?.addEventListener('click', e => copy(d.text, e.currentTarget));
  liveFoot(m);
}
// An image from the Files pane (rows 23/26/27 adds): read-only; the words and the check are helpers.mjs's, shared with the phone.
function imageModal(m, body) {
  const project = /^:project-files\/([0-9a-f-]{36})\/(.+)$/.exec(m.name), name = project ? project[2] : m.name;
  outer.$('#mdlT').textContent = name;
  outer.$('#mdlFoot').innerHTML = `<span class="muted sm mono truncate">${esc(name)}</span><span class="spacer"></span><span class="muted sm">Read-only</span>`;
  if (m.image === undefined) {
    m.image = null;
    window.p9.mission(project ? 'projectImage' : 'image', project ? { project: project[1], path: project[2] } : { path: m.name }).then(r => {
      const src = r.status === 200 && fileImageSrc(r.body);
      m.image = src ? { src } : { error: r.status === 200 ? 'not-an-image' : r.body?.error || String(r.status) };
      if (outer.S.modal === m) outer.renderModal();
    }).catch(() => { m.image = { error: 'daemon-unavailable' }; if (outer.S.modal === m) outer.renderModal(); });
  }
  const i = m.image;
  body.innerHTML = !i ? '<p class="sm muted file-image-note">Loading…</p>' : i.error ? `<p class="sm muted file-image-note">${esc(fileImageError[i.error] || 'Not readable: ' + i.error)}</p>`
    : `<div class="file-image"><img src="${i.src}" alt="${esc(name)}"></div>`;
}
// O173: with a draft, Discard drops it and reads the file from disk again, so closing and reopening shows no draft. Not while
// a save is on its way: that save still writes, so Discard is disabled until it answers (it cannot cancel a sent save).
// The flag is per file, not per modal: the draft is shared by every modal on live:<name>, and a reopened file is a new modal.
const liveSaving = new Set();
const showing = name => outer.S.modal?.kind === 'file' && outer.S.modal.live && outer.S.modal.name === name ? outer.S.modal : null;
function liveFoot(m) {
  const key = liveKey(m.name), busy = liveSaving.has(key);
  outer.$('#mdlFoot').innerHTML = `<span class="muted sm mono truncate">${esc(m.name)}</span><span class="spacer"></span><span class="muted sm">Ctrl S</span>${outer.dirty(key) ? `<button data-slot="button" data-variant="outline" data-size="sm" data-discard${busy ? ' disabled' : ''}>Discard</button>` : ''}${outer.saveBtn(key)}`;
  const b = outer.$('#mdlFoot [data-savefile]'); if (b) b.onclick = () => saveLive(m);
  const x = outer.$('#mdlFoot [data-discard]'); if (x) x.onclick = () => { if (liveSaving.has(key)) return; delete outer.S.docs[key]; m.asked = m.conflict = null; outer.renderModal(); };
}
async function saveLive(m, hash) {
  const key = liveKey(m.name), d = outer.S.docs[key]; if (!d || liveSaving.has(key) || (!hash && !outer.dirty(key))) return;
  liveSaving.add(key); const text = d.text; if (showing(m.name)) liveFoot(showing(m.name));
  const r = await window.p9.mission('save', { path: m.name, hash: hash || d.hash, content: text }).catch(() => ({ status: 503 }));
  liveSaving.delete(key);
  const at = showing(m.name) ?? m; // the modal that shows this file now: the one that saved, or the same file reopened meanwhile
  if (r.status === 200) { d.saved = text; d.hash = r.body.hash; at.conflict = null; outer.toast({ kind: 'saved', txt: 'Saved ' + m.name, level: 'ok' }, true); }
  else if (r.status === 409) { at.conflict = { diskContent: r.body.diskContent, diskHash: r.body.diskHash }; outer.toast({ kind: 'not saved', txt: m.name + ' changed on disk since you opened it. Your text is still here.', level: 'warn' }, true); }
  else outer.toast({ kind: 'not saved', txt: 'Could not save ' + m.name + ': ' + outer.saveWhy(r) + '. Your text is still here.', level: 'bad', start: 'Your text is still in the editor, so nothing is lost. Fix the reason above (it names the file and why), then press Ctrl S again.' }, true);
  if (showing(m.name)) outer.renderModal();
}
function noteFoot(m) {
  const key = noteKey(m.root, m.path), base = m.path.split('/').pop();
  outer.$('#mdlFoot').innerHTML = m.readOnly
    ? `<span class="muted sm mono truncate">${esc(m.path)}</span><span class="spacer"></span><span class="muted sm" data-readonly>Read-only: File protection is on</span>`
    : m.renaming
    ? `<input data-slot="input" data-rename value="${esc(m.newName ?? base)}" aria-label="New name"><button data-slot="button" data-size="sm" data-rename-go>Rename</button><button data-slot="button" data-variant="outline" data-size="sm" data-rename-x>Cancel</button>`
    : `<span class="muted sm mono truncate">${esc(m.path)}</span><span class="spacer"></span><button data-slot="button" data-variant="outline" data-size="sm" data-rename-open>Rename</button><button data-slot="button" data-variant="outline" data-size="sm" data-mode>${m.edit ? 'Preview' : 'Edit'}</button>${outer.dirty(key) ? `<span data-slot="badge">draft</span><button data-slot="button" data-size="sm" data-savenote>Save</button>` : '<span class="muted sm">saved</span>'}`;
  const on = (sel, fn) => { const b = outer.$('#mdlFoot ' + sel); if (b) b.onclick = fn; };
  on('[data-mode]', () => { m.edit = !m.edit; outer.renderModal(); });
  on('[data-savenote]', () => saveNote(m));
  on('[data-rename-open]', () => { m.renaming = true; m.newName = base; noteFoot(m); outer.$('#mdlFoot [data-rename]').focus(); });
  on('[data-rename-x]', () => { m.renaming = false; noteFoot(m); });
  const input = outer.$('#mdlFoot [data-rename]'); if (!input) return;
  input.oninput = () => { m.newName = input.value; };
  const go = async () => {
    let name = (m.newName || '').trim();
    if (name.includes('/')) return outer.toast({ kind: 'not renamed', txt: 'Type a new name only; moving a note to another folder is not supported.', level: 'warn' }, true);
    if (!/\.md$/i.test(name)) name += '.md';
    if (name === base) { m.renaming = false; return noteFoot(m); }
    const r = await window.p9.mission('noteRename', { root: m.root, path: m.path, name });
    if (r.status !== 200) return outer.toast({ kind: 'not renamed', txt: name + ': ' + (noteError[r.body?.error] || 'could not rename it (' + (r.body?.error || r.status) + ')'), level: 'warn' }, true);
    outer.S.docs[noteKey(m.root, r.body.path)] = outer.S.docs[key]; delete outer.S.docs[key];
    m.path = r.body.path; m.renaming = false; if (m.back) m.back.list = undefined;
    outer.toast({ kind: 'renamed', txt: base + ' → ' + name, level: 'ok' }, true);
    if (outer.S.modal === m) outer.renderModal();
  };
  on('[data-rename-go]', go);
  input.onkeydown = e => { if (e.key === 'Enter') go(); else if (e.key === 'Escape') { e.preventDefault(); m.renaming = false; noteFoot(m); } };
}
// The same reply as answerLive: on 409 the draft stays and the banner offers the disk version or a save over it.
async function saveNote(m, hash) {
  const d = outer.S.docs[noteKey(m.root, m.path)]; if (!d || m.saving) return;
  m.saving = true; const text = d.text;
  const r = await window.p9.mission('noteSave', { root: m.root, path: m.path, hash: hash || d.hash, content: text }).catch(() => ({ status: 503 }));
  m.saving = false;
  if (r.status === 200) { d.saved = text; d.hash = r.body.hash; m.conflict = null; outer.toast({ kind: 'saved', txt: 'Saved ' + m.path, level: 'ok' }, true); }
  else if (r.status === 409) { m.conflict = { diskContent: r.body.diskContent, diskHash: r.body.diskHash }; outer.toast({ kind: 'not saved', txt: m.path + ' changed on disk since you opened it. Your text is still here.', level: 'warn' }, true); }
  else outer.toast({ kind: 'not saved', txt: 'Could not save ' + m.path + ': ' + outer.saveWhy(r) + '. Your text is still here.', level: 'bad', start: 'Your text is still in the editor, so nothing is lost. Fix the reason above (it names the file and why), then press Ctrl S again.' }, true);
  if (outer.S.modal === m) outer.renderModal();
}
// One section's items (notes, folders, refs, logs, scripts, data tiles, cards, links, checklists, quick note): the body
// of the section's window, and the same items drawn open in a page column (place col1 to col3). o says where they are drawn:
// write(el, html) puts the markup in and says whether it changed; shown() is false once the window closed or the panel left
// the page; seen() is whether it is on screen now (tiles and cards ask the daemon only then); redraw() draws it again; back is
// what a window opened from here returns to.
// Which box each part draws in (no box: on its own); the classes are the boxes' CSS.
const SECTION_BOX = { notes: 'mlist', folders: 'mlist', refs: 'mlist', logs: 'mlist', buttons: 'mlist', data: 'dtiles', cards: 'dtiles', links: 'dtiles', checklists: 'cks', widgets: 'wdgs' };
function sectionBody(m, body, g, o) {
  const l = outer.M.scripts[g], sp = spaceOf(g);
  // Data tiles and links (M3, threat model row 70): a tile asks the daemon only while this section is on screen, every 30 s.
  // Cards (M5, threat model row M5): the card's HTML in the artifact frame; its script's answer goes in as data, and
  // anything else (Allow, a bad run, an unreadable file) shows under the frame as text.
  m.tiles ||= {}; m.cardHtml ||= {}; m.ck ||= {}; m.counts ||= {}; m.frames ||= {}; m.sent ||= {};
  const runs = [...(sp?.data || []), ...(sp?.cards || [])];
  // A tile or card with frame false is the section's body: no box and no title of its own (W-K; absent draws the frame).
  const bare = t => t.frame === false ? ' data-noframe' : '';
  // A card file edited on disk (its v changed in the overview): read it again and make its frame again.
  const cardsKey = (sp?.cards || []).map(c => c.id + ':' + c.v).join();
  if (m.cardsKey !== undefined && m.cardsKey !== cardsKey) { for (const id in m.frames) m.frames[id]?.remove(); m.frames = {}; m.sent = {}; m.cardHtml = {}; m.cardsRead = false; }
  m.cardsKey = cardsKey;
  const cardNote = c => m.cardHtml[c.id]?.error ? `<p class="tile-note">Could not read the card: ${esc(m.cardHtml[c.id].error)}</p>` : m.tiles[c.id]?.json !== undefined ? '' : tileHtml(m.tiles[c.id], esc, 'card');
  // Row 76: typed text lives on m, so a tile answering (a redraw) does not wipe it. It sits under the section's text, so Save
  // shows without scrolling.
  const qn = sp?.quick_note; if (qn) m.qn ||= {};
  // The parts in the section's order field (PARTS when it names none). Neighbours that share a box share it, so the default order
  // draws what it drew before order existed: one list of rows, one row of tiles, one block of checklists.
  const part = {
    text: sp?.text ? `<p class="sm" data-space-text>${esc(sp.text)}</p>` : '', quick_note: qn ? quickNoteHtml(esc, qn, m.qn, true) : '',
    notes: sp?.notes ? `<li><button data-notes="${esc(sp.notes)}"><span class="kind">notes</span><span class="truncate">Notes</span><span class="sub truncate">${esc(sp.notes)}</span></button></li>` : '',
    folders: (sp?.folders || []).map((f, i) => `<li><button data-folder="${i}"><span class="kind">folder</span><span class="truncate">${esc(f.title)}</span><span class="sub" data-count>${m.counts?.[f.id] ?? '…'}</span></button></li>`).join(''),
    refs: (sp?.refs || []).map((r, i) => r.missing
      ? `<li><button data-ref-missing disabled title="No script, app or page has this ID"><span class="kind">ref</span><span class="truncate">${esc(r.id)}</span><span class="sub">not found</span></button></li>`
      : `<li><button data-ref="${i}"><span class="kind">${{ scripts: 'script', apps: 'app', pages: 'link' }[r.kind]}</span><span class="truncate">${esc(r.title)}</span></button></li>`).join(''),
    logs: (sp?.logs || []).map(g => `<li><button data-slog="${esc(g.id)}"><span class="kind">log</span><span class="truncate">${esc(g.title)}</span></button></li>`).join(''),
    buttons: l.map((s, i) => listRow(i, `<span class="lvl" data-l="${esc(s[3])}"></span>`, esc(s[1]), esc(s[2]) + ' · ' + esc(s[4]) + ', ' + esc(s[5]))).join(''),
    data: (sp?.data || []).map(d => `<section class="dtile" data-tile="${esc(d.id)}" data-l="${tileLevel(m.tiles[d.id])}"${bare(d)}><h3>${esc(d.title)}</h3>${tileHtml(m.tiles[d.id], esc)}</section>`).join(''),
    cards: (sp?.cards || []).map(c => `<section class="dtile dcard" data-tile="${esc(c.id)}" data-l="${tileLevel(m.tiles[c.id])}" data-card${bare(c)}><h3><span>${esc(c.title)}</span>${(c.buttons || []).map(id => { const s = scriptById(id); return s ? `<button class="cbtn" data-cbtn="${esc(id)}">${esc(s[1])}</button>` : `<button class="cbtn" disabled title="No script or button has this ID">${esc(id)} not found</button>`; }).join('')}</h3><div class="card-frame"></div><div class="card-note" role="status">${cardNote(c)}</div></section>`).join(''),
    links: (sp?.links || []).map(l => linkHtml(l, esc)).join(''),
    // Checklists (row M4-a): read when the section opens and after each press; the daemon checks every write again.
    checklists: (sp?.checklists || []).map(c => `<section class="ck" data-ck="${esc(c.id)}"><h3>${esc(c.title)}</h3>${checklistHtml(c.id, m.ck[c.id], esc, m.armed)}</section>`).join(''),
    // P9's own panels inside the section (W-I), filled by fillWidgets below.
    widgets: (sp?.widgets || []).map(w => `<section class="wdg" data-widget="${esc(w)}" data-wkey="${esc(g)}"><h3>${esc(w === 'waiting' ? 'Waiting on you' : BUILTIN[w] ?? outer.wins[WIDGET_WIN[w]].title())}</h3><div class="wbody"></div></section>`).join(''),
  };
  // An empty part draws nothing and does not split its neighbours; the list of rows is still drawn once, empty, when no part has a row (as before).
  const boxes = [], rows = Object.keys(part).some(k => SECTION_BOX[k] === 'mlist' && part[k]);
  for (const k of partOrder(sp?.order, PARTS)) {
    const box = SECTION_BOX[k], last = boxes.at(-1);
    if (!part[k] && (box !== 'mlist' || rows || boxes.some(b => b.box === 'mlist'))) continue;
    if (box && last?.box === box) last.html += part[k]; else boxes.push({ box, html: part[k] });
  }
  // O94 (window, 2026-11-15): the window draws whole (on the page, a changed section does too), and that made every card's frame
  // again on each draw (a tile's answer, a checklist press); a click landing in a card at that moment went to a frame already gone.
  // Where an element can move without reloading (Element.moveBefore: the desktop app's Chromium; not phone Safari or older
  // browsers), a card whose HTML and theme are unchanged keeps its live frame: it waits beside the body while the markup is
  // written and goes into the card's new box. Only a frame still in this body is kept, so after a window opened from here and
  // closed with Back (which wrote the body) the frames are made fresh, as before. Without moveBefore every draw makes them again.
  const look = c => m.cardHtml[c.id]?.html + document.documentElement.classList.contains('dark');
  const keep = typeof body.moveBefore !== 'function' ? [] : (sp?.cards || []).filter(c => body.contains(m.frames[c.id]) && m.made?.[c.id] === look(c))
    .map(c => { const f = m.frames[c.id], old = f.closest('[data-card]'); body.parentNode.moveBefore(f, body); return [c, f, old.dataset.rendered]; });
  const fresh = o.write(body, boxes.map(b => !b.box ? b.html : `<${b.box === 'mlist' ? 'ul' : 'div'} class="${b.box}">${b.html}</${b.box === 'mlist' ? 'ul' : 'div'}>`).join(''));
  for (const [{ id, title }, f, was] of keep) { // with the card's state: rendered or not, and the error it stopped with
    const box = body.querySelector(`[data-card][data-tile="${CSS.escape(id)}"]`);
    if (!box) { f.remove(); continue; }
    box.querySelector('.card-frame').moveBefore(f, null); f.title = title; // a renamed card keeps its frame; the frame's name follows
    if (was !== undefined) box.dataset.rendered = was;
    // A card that throws while it draws says error and then rendered, so the error is kept on m, not read off the state.
    if (m.cardErr?.[id]) box.querySelector('.card-note').textContent = m.cardErr[id];
  }
  // A frame in the box (unchanged markup, or a kept frame) gets a newer answer posted into it; an empty box gets a new frame.
  for (const c of sp?.cards || []) {
    const box = body.querySelector(`[data-card][data-tile="${CSS.escape(c.id)}"]`), html = m.cardHtml[c.id]?.html, at = box.querySelector('.card-frame');
    if (typeof html !== 'string') continue;
    const json = m.tiles[c.id]?.json;
    if (at.firstChild) { if (box.dataset.rendered === 'rendered' && json !== undefined && m.sent[c.id] !== json) { m.sent[c.id] = json; m.frames[c.id]?.contentWindow?.postMessage({ p9: 'data', json }, '*'); } continue; }
    // Wall 15: p9open(path) from the card opens one of its folder's files, only right after a click in this card (the click
    // activates this window too and focuses the frame; a click elsewhere, such as the one that opened the section, does not
    // count), so a card cannot pop windows on its own. The daemon opens only files the folder lists. The frame is another
    // process: its message can come before this page hears the frame took focus, so focus gets 1 s to arrive (256 ms seen in the dev space).
    const onOpen = (p, since = performance.now()) => navigator.userActivation?.isActive && document.activeElement === m.frames[c.id]
      ? outer.openModal({ kind: 'hubtext', title: p.split('/').pop(), req: { id: c.id, path: p }, call: 'folderFile', back: o.back })
      : performance.now() - since < 1000 && outer.setTimeout(() => onOpen(p, since), 25);
    (m.made ||= {})[c.id] = look(c); delete m.cardErr?.[c.id];
    const frame = m.frames[c.id] = mountCard(at, c.title, html, { ...outer.FRAME, onOpen, onState: (kind, text) => {
      const box = frame.closest('[data-card]'); // the card's box now: a kept frame has moved into a newer one
      if (box) box.dataset.rendered = kind;
      const now = m.tiles[c.id]?.json;
      if (kind === 'rendered' && now !== undefined) { m.sent[c.id] = now; frame.contentWindow?.postMessage({ p9: 'data', json: now }, '*'); }
      if (kind === 'error') { (m.cardErr ||= {})[c.id] = 'The card stopped with an error: ' + text; if (box) box.querySelector('.card-note').textContent = m.cardErr[c.id]; }
    } });
  }
  body.querySelectorAll('[data-cbtn]').forEach(b => b.onclick = () => outer.openModal({ kind: 'script', s: scriptById(b.dataset.cbtn), back: o.back }));
  if (sp?.cards?.length && !m.cardsRead) { m.cardsRead = true; Promise.all(sp.cards.map(c => window.p9.mission('card', { id: c.id }).then(r => {
    m.cardHtml[c.id] = r.status === 200 ? { html: r.body.html } : { error: r.body?.detail || r.body?.error || String(r.status) }; }))).then(() => o.shown() && o.redraw()); }
  const ckLoad = (id) => { const n = m.gen; return window.p9.mission('checklist', { id }).then(r => { if (m.gen === n) m.ck[id] = checklistAnswer(r.status, r.body); }); };
  if (sp?.checklists?.length && !m.ckRead) { m.ckRead = true; Promise.all(sp.checklists.map(c => ckLoad(c.id))).then(() => o.shown() && o.redraw()); }
  body.querySelectorAll('[data-ck] button').forEach(b => b.onclick = async () => {
    const id = b.closest('[data-ck]').dataset.ck, act = checklistAction(b, m.ck[id], m.armed);
    if (!act) return;
    m.armed = act.arm || '';
    if (act.arm) return o.redraw();
    b.disabled = true;
    const r = await window.p9.mission('checklistSet', act.body), w = outer.S.modal?.g === g && outer.S.modal;
    // O238: the page column and the window each keep their own copy of this section; both read its checklists and tiles again,
    // and an answer asked before the write (gen) is dropped, so it cannot draw the old state over the new.
    for (const x of [inlineSec[g], w]) if (x) { if (x !== m) x.ckRead = false; x.pulled = false; x.gen = (x.gen || 0) + 1; }
    await ckLoad(id);
    if (r.status >= 300 && !m.ck[id].error) m.ck[id].note = r.body?.error || String(r.status);
    if (o.shown()) o.redraw();
    if (inlineSec[g] !== m) secInline(g);
    if (w && w !== m) outer.renderModal();
  });
  const lv = ['bad', 'warn'].find(l => runs.some(r => tileLevel(m.tiles[r.id]) === l)) || '';
  if ((secLv[g] || '') !== lv) { secLv[g] = lv; outer.setTimeout(outer.renderMission); }
  // O45: the 30 s pull redrew on every answer, and the window draws whole, so each card's frame was made
  // again six times a tick with nothing new; a click in a card at that moment was lost. Only a changed answer draws again.
  const pull = (d) => { const n = m.gen; return window.p9.mission('data', { id: d.id }).then(r => { const a = tileAnswer(r.status, r.body); if (m.gen !== n) return;
    if (JSON.stringify(a) === JSON.stringify(m.tiles[d.id])) return; m.tiles[d.id] = a; if (o.shown()) o.redraw(); }); };
  if (runs.length && !m.pulled && o.seen()) { m.pulled = true; runs.forEach(pull); }
  if (runs.length && !m.pulling) m.pulling = setInterval(() => { if (!o.shown()) { clearInterval(m.pulling); m.pulling = 0; return; } if (o.seen()) { m.pulled = true; runs.forEach(pull); } }, 30000);
  body.querySelectorAll('[data-tile-allow]').forEach(b => b.onclick = () => { const d = runs.find(x => x.id === b.closest('[data-tile]').dataset.tile);
    window.p9.mission('dataAllow', { id: d.id }).then(r => { if (r.status === 200) return pull(d); m.tiles[d.id] = tileAnswer(r.status, r.body); o.redraw(); }); });
  body.querySelectorAll('[data-tile-link]').forEach(a => a.onclick = e => { e.preventDefault(); window.p9.openLink?.(a.href); });
  const form = qn && body.querySelector('[data-quicknote]');
  if (form) {
    form.oninput = () => { m.qn.title = form.elements.title.value; m.qn.body = form.elements.body.value; };
    form.onsubmit = async e => {
      e.preventDefault();
      const file = quickNotePath(qn.path, m.qn.title || '');
      const r = file ? await window.p9.mission('noteCreate', { root: qn.root, path: file, content: (m.qn.body || '').replace(/\s+$/, '') + '\n' }) : null;
      m.qn = r?.status === 201 ? { status: quickNoteWords(r, file, qn) } : { ...m.qn, status: r ? quickNoteWords(r, file, qn) : 'Type a title first.' };
      o.redraw();
    };
  }
  const back = o.back;
  body.querySelectorAll('[data-weblink]').forEach(b => b.onclick = () => outer.openModal({ kind: 'weblink', l: sp.links.find(x => x.id === b.dataset.weblink), back }));
  body.querySelectorAll('[data-i]').forEach(b => b.onclick = () => outer.openModal({ kind: 'script', s: l[+b.dataset.i], back }));
  body.querySelectorAll('[data-slog]').forEach(b => b.onclick = () => outer.openModal({ kind: 'hubtext', title: b.textContent.replace(/^log/, ''), req: { name: b.dataset.slog }, call: 'spaceLog', back }));
  body.querySelectorAll('[data-notes]').forEach(b => b.onclick = () => outer.openModal({ kind: 'notes', root: b.dataset.notes, title: gTitle(g), back }));
  // Folder lists (row 68): the count comes from the daemon's own list, once per opening of the section (on the page, once per
  // version of the section).
  for (const f of sp?.folders || []) if (!(f.id in m.counts)) {
    m.counts[f.id] = null;
    window.p9.mission('folder', { id: f.id }).then(r => { m.counts[f.id] = r.status === 200 ? r.body.total : '?'; if (o.shown()) o.redraw(); });
  }
  body.querySelectorAll('[data-folder]').forEach(b => b.onclick = () => outer.openModal({ kind: 'folder', f: sp.folders[+b.dataset.folder], back }));
  // A reference (M2) opens what it names, the way its own tile does.
  body.querySelectorAll('[data-ref]').forEach(b => b.onclick = () => {
    const r = sp.refs[+b.dataset.ref];
    if (r.kind === 'scripts') { const s = Object.values(outer.M.scripts).flat().find(x => x[0] === r.id); return s && outer.openModal({ kind: 'script', s, back }); }
    if (!outer.live.on) return outer.toast({ kind: 'launched', txt: r.title + ' (mock: nothing opens)', level: 'ok' }, true);
    const page = r.kind === 'pages' ? outer.M.pages.find(x => x[2] === r.id) : null;
    if (page && !/^https?:\/\//i.test(page[1])) return outer.openModal({ kind: 'link', page, back });
    launchLive(r.title, { kind: r.kind, id: r.id });
  });
  fillWidgets(body, back);
}
// Modal bodies for Mission: a category's buttons, one script (args, Run, output), a Wiki inbox batch
let editor = null; // mission-editor.mjs once loaded
function missionModal(m, body, row) {
  if (m.kind === 'win') {
    const w = outer.wins[m.id]; if (!w || (w.show && !w.show() && !m.any)) return outer.closeModal(); // any: the panel's Usage button opens it whatever the space shows
    outer.$('#mdlT').textContent = w.title();
    outer.setHTML(body, panel(m.id, esc(w.title()), w.body())); // O152: patched in place, so a redraw keeps the node under the pointer
    bindWin(body, m); missionLive();
    body.onscroll = () => { winTop[m.id] = body.scrollTop; };
  } else if (m.kind === 'scripts') {
    if (!outer.M.scripts[m.g]) return outer.closeModal();
    const n = sectionRows(m.g, outer.M.scripts[m.g]), word = n > outer.M.scripts[m.g].length ? 'item' : 'script';
    outer.$('#mdlT').textContent = `${gTitle(m.g)} · ${n} ${word}${n === 1 ? '' : 's'}`;
    sectionBody(m, body, m.g, { write: writeKeep, shown: () => outer.S.modal === m, seen: () => !document.hidden, redraw: outer.renderModal, back: m });
  } else if (m.kind === 'folder') {
    outer.$('#mdlT').textContent = m.f.title;
    if (m.list === undefined) { m.list = null; window.p9.mission('folder', { id: m.f.id }).then(r => { m.list = r.status === 200 ? r.body : { error: r.body?.error || String(r.status) }; if (outer.S.modal === m) outer.renderModal(); }); }
    const l = m.list, now = Date.now();
    body.innerHTML = !l ? '<p class="sm muted">Loading…</p>' : l.error === 'unknown-root' && m.f.root === 'vault' ? (window.p9.pickVault
      ? '<div class="review"><p class="sm">Mission lists this once it knows your vault folder.</p><button data-slot="button" data-variant="outline" data-pick-vault>Pick the vault folder</button></div>'
      : '<div class="review"><p class="sm">Pick the vault folder in the P9 desktop app.</p></div>') : l.error ? `<p class="sm muted">Could not list this folder (${esc(l.error)})</p>`
      : l.files.length ? `<ul class="mlist">${l.files.map((f, i) => row(i, '<span class="kind">file</span>', esc(f.name), esc(ago(Math.max(0, Math.round((now - f.modified) / 60000)))) + ' ago')).join('')}</ul>` : '<p class="empty">No files match.</p>';
    outer.$('#mdlFoot').innerHTML = l && !l.error ? `<span class="muted sm" data-folder-count>${l.total} file${l.total === 1 ? '' : 's'}${l.files.length < l.total ? ', the newest ' + l.files.length + ' shown' : ''}${l.partial ? ' · a very big folder: not every file was looked at' : ''}</span>` : '';
    const pv = body.querySelector('[data-pick-vault]'); if (pv) pv.onclick = async () => { if (await pickVault()) { m.list = undefined; outer.renderModal(); } };
    body.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const f = l.files[+b.dataset.i]; outer.openModal({ kind: 'hubtext', title: f.name, req: { id: m.f.id, path: f.path }, call: 'folderFile', back: m }); });
  } else if (m.kind === 'notes') notesModal(m, body, row);
  else if (m.kind === 'note') outer.noteModal(m, body);
  else if (m.kind === 'link') {
    outer.$('#mdlT').textContent = 'Open ' + m.page[0] + '?';
    body.innerHTML = `<div class="review"><p>This opens another program on this computer with this link:</p><pre class="out" data-link>${esc(m.page[1])}</pre><p class="muted sm">It is on your allowed-schemes list in settings.json. Only open it if you recognise it.</p></div>`;
    outer.$('#mdlFoot').innerHTML = `<span class="spacer"></span><button data-slot="button" data-variant="outline" data-cancel>Cancel</button><button data-slot="button" data-open>Open link</button>`;
    outer.$('#mdlFoot [data-cancel]').onclick = () => (m.back ? outer.openModal(m.back) : outer.closeModal());
    outer.$('#mdlFoot [data-open]').onclick = () => { launchLive(m.page[0], { kind: 'pages', id: m.page[2], confirm: true }); m.back ? outer.openModal(m.back) : outer.closeModal(); };
  } else if (m.kind === 'weblink') {
    // Rows 74, 75: the typed text is URL-encoded as the daemon does it, so the link shown is the link that opens.
    const link = () => m.l.url + (m.l.ask ? encodeURIComponent((m.text || '').trim()) : ''), scheme = m.l.url.split(':')[0];
    outer.$('#mdlT').textContent = m.l.title;
    body.innerHTML = `<div class="review">${m.l.ask ? `<label>${esc(m.l.ask)}<input data-slot="input" data-weblink-text maxlength="200" value="${esc(m.text || '')}"></label>` : ''}`
      + `<p>This opens another program on this computer with this link:</p><pre class="out" data-link>${esc(link())}</pre>`
      + (m.error ? `<p class="sm" role="status" data-weblink-error>${esc(m.error)}</p>` : '') + '</div>';
    outer.$('#mdlFoot').innerHTML = '<span class="spacer"></span><button data-slot="button" data-variant="outline" data-cancel>Cancel</button><button data-slot="button" data-open>Open</button>';
    const input = body.querySelector('[data-weblink-text]');
    if (input) { input.oninput = () => { m.text = input.value; body.querySelector('[data-link]').textContent = link(); }; input.focus(); }
    outer.$('#mdlFoot [data-cancel]').onclick = () => (m.back ? outer.openModal(m.back) : outer.closeModal());
    outer.$('#mdlFoot [data-open]').onclick = async () => {
      if (m.l.ask && !(m.text || '').trim()) { m.error = 'Type the ' + m.l.ask.toLowerCase() + ' first.'; return outer.renderModal(); }
      const r = await window.p9.mission('link', { id: m.l.id, ...(m.l.ask ? { text: m.text } : {}), confirm: true });
      if (r.status === 200) return m.back ? outer.openModal(m.back) : outer.closeModal();
      m.error = r.body?.error === 'scheme-not-allowed' ? `${scheme} links are not allowed yet.${scheme === 'obsidian' ? ' Picking the vault folder allows them.' : ' Add ' + scheme + ' to page_schemes in the Mission settings file.'}`
        : 'Not opened (' + (r.body?.error || r.status) + ').';
      outer.renderModal();
    };
  } else if (m.kind === 'script') {
    if (m.s[6]?.live) m.s = scriptById(m.s[0]) ?? m.s; // the overview's row now: its last run (O237)
    const f = document.activeElement, typing = body.contains(f) && f.dataset.arg ? [f.dataset.arg, f.selectionStart, f.selectionEnd] : null;
    const [id, name, desc, lvl, last, dur, x = {}] = m.s;
    m.args ||= (x.args || []).map(() => '');
    // #489 fix 2: this window's output is its run's, shown while it runs and until the last run is another one (another device's).
    const out = m.out && (m.running || x.at === m.outAt || !(x.at > m.before)) ? m.out : null;
    outer.$('#mdlT').textContent = name;
    body.innerHTML = `<div class="review"><span class="kind"><span class="lvl" data-l="${esc(lvl)}"></span> last run ${esc(last)} · ${esc(dur)}</span><p>${esc(desc)}</p>${(x.args || []).map((a, i) => a.choices ? `<label>${esc(a.label)}<select data-slot="select" data-arg="${i}"><option value="">(none)</option>${a.choices.map(ch => `<option${m.args[i] === ch ? ' selected' : ''}>${esc(ch)}</option>`).join('')}</select></label>` : `<label>${esc(a.label ?? a)}<input data-slot="input" data-arg="${i}" value="${esc(m.args[i])}"></label>`).join('')}${out ? `<pre class="out">${esc(out.join('\n'))}</pre>` : x.tail ? `<pre class="out" data-last-tail>${esc(x.tail)}</pre>` : ''}</div>`;
    body.querySelectorAll('[data-arg]').forEach(inp => inp.oninput = inp.onchange = () => { m.args[+inp.dataset.arg] = inp.value; });
    if (typing) { const inp = body.querySelector(`[data-arg="${typing[0]}"]`); inp?.focus(); try { inp?.setSelectionRange(typing[1], typing[2]); } catch {} } // a poll's redraw keeps the field being typed in
    outer.$('#mdlFoot').innerHTML = `<span class="muted sm">${x.confirm ? 'Changes things: asks before it runs' : x.live ? (x.terminal ? 'Opens in a terminal' : 'Runs on this computer') : 'Mock: nothing runs'}</span><span class="spacer"></span>${out ? '<button data-slot="button" data-variant="outline" data-copy>Copy output</button>' : ''}<button data-slot="button" data-run>${m.armed ? 'Confirm run' : 'Run'}</button>`;
    outer.$('#mdlFoot [data-run]').onclick = () => {
      if (x.confirm && !m.armed) { m.armed = true; return outer.renderModal(); }
      m.armedRun = m.armed; m.armed = false; m.out = ['running…']; m.before = x.at ?? 0; outer.renderModal();
      if (x.live) return runLive(m, id);
      outer.setTimeout(() => { m.out = outer.M.outputs[id] || [name, '', '[ok] ' + name + ' completed']; if (outer.S.modal === m) outer.renderModal(); }, 600);
    };
    if (out) outer.$('#mdlFoot [data-copy]').onclick = e => copy(out.join('\n'), e.currentTarget);
  } else if (m.kind === 'hubtext') {
    outer.$('#mdlT').textContent = m.title;
    if (m.text === undefined) { m.text = 'Loading…'; window.p9.mission(m.call, m.req).then(r => { m.text = r.status === 200 ? r.body.text : 'Could not read it (' + (r.body?.error || r.status) + ')'; m.canFix = r.status === 200 && !!r.body.fix; if (outer.S.modal === m) outer.renderModal(); }); }
    body.innerHTML = `<div class="review"><pre class="out">${esc(m.text)}</pre></div>`;
    const fix = m.canFix && outer.liveChat.on; // a space folder with fix text (wall 15)
    outer.$('#mdlFoot').innerHTML = `<span class="spacer"></span>${fix ? '<button data-slot="button" data-fix>Fix with Claude</button>' : ''}<button data-slot="button" data-variant="outline" data-copy>Copy</button>`;
    outer.$('#mdlFoot [data-copy]').onclick = e => copy(m.text, e.currentTarget);
    // The daemon starts the chat; the 'created' event adds the session, so the chat modal fills in as events arrive.
    if (fix) outer.$('#mdlFoot [data-fix]').onclick = async () => {
      const r = await window.p9.mission('fix', { id: m.req.id, path: m.req.path });
      if (r.status === 201) outer.openModal({ kind: 'chat', id: r.body.conversation, back: m });
      else outer.toast({ kind: 'chat', txt: 'Fix with Claude: ' + (r.body?.error || r.status), level: 'bad' }, true);
    };
  } else if (m.kind === 'sprint') {
    outer.$('#mdlT').textContent = outer.SP.data ? 'Sprint · ' + (outer.SP.data.sprint || 'unnamed') : 'Sprint';
    // The rings, the status file's error and Folder sprints are drawn by the lazy chunk, out of the shell's startup JS (O233);
    // a redraw keeps the last body (and its scroll) until the new one is ready.
    if (!body.querySelector('[data-sprint-body]')) body.innerHTML = '<div class="review" data-sprint-body><p class="sm muted">Loading…</p></div>';
    import('./mission-sprint.mjs').then(v => (b) => v.sprintBody(outer, m, b), () => (b) => { b.textContent = 'Cannot show the sprint right now.'; })
      .then(draw => { if (outer.mdl.open && outer.S.modal === m) draw(body); }); // loaded or not, only into this window
    const runs = sprintScripts(m.sec);
    outer.$('#mdlFoot').innerHTML = runs.map(([id, label, row]) => `<button data-slot="button" data-variant="outline" data-sprint-run="${esc(id)}"${row ? '' : ` disabled title="Add a ${esc(id)} button to the registry"`}>${esc(label)}</button>`).join('')
      + '<span class="spacer"></span><button data-slot="button" data-sprint-tmux>Open tmux</button>';
    outer.$('#mdlFoot').querySelectorAll('[data-sprint-run]').forEach(b => b.onclick = () => outer.openModal({ kind: 'script', s: runs.find(r => r[0] === b.dataset.sprintRun)[2], back: m }));
    outer.$('#mdlFoot [data-sprint-tmux]').onclick = async () => {
      const r = await window.p9.mission('sprintTmux');
      if (r.status === 201) { outer.closeModal(); outer.showTerminal(r.body.terminal); }
      else { m.hint = 'Open tmux: ' + (r.body?.error || r.status); outer.renderModal(); }
    };
  } else if (m.kind === 'sprintcopy') {
    // Loaded or not, it draws only while this window is still the one open.
    import('./sprint-copy-view.mjs').then(v => () => v.sprintCopyModal(outer, m, body), () => () => { body.textContent = 'Cannot show this copy right now.'; })
      .then(draw => { if (outer.mdl.open && outer.S.modal === m) draw(); });
  } else if (m.kind === 'idea') {
    // New idea (the old hub's box): the daemon names the file and refuses to replace one.
    outer.$('#mdlT').textContent = 'New idea';
    body.innerHTML = `<div class="review"><p class="sm muted">Saved to _ideas/, or _ideas/needs-done/ for a fix to something that already exists.</p><label>Name<input data-slot="input" data-idea-name value="${esc(m.name)}" placeholder="short-name"></label><label>Idea<textarea data-idea-text rows="8">${esc(m.text)}</textarea></label><label class="sm"><input type="checkbox" data-idea-needs${m.needs ? ' checked' : ''}> A fix for an existing project (needs-done)</label></div>`;
    body.querySelector('[data-idea-name]').oninput = e => { m.name = e.target.value; };
    body.querySelector('[data-idea-text]').oninput = e => { m.text = e.target.value; };
    body.querySelector('[data-idea-needs]').onchange = e => { m.needs = e.target.checked; };
    outer.$('#mdlFoot').innerHTML = '<span class="spacer"></span><button data-slot="button" data-idea-save>Save idea</button>';
    outer.$('#mdlFoot [data-idea-save]').onclick = async () => {
      const r = await window.p9.mission('idea', { name: m.name, text: m.text, needs_done: m.needs });
      outer.toast({ kind: r.status === 201 ? 'saved' : 'not saved', txt: r.status === 201 ? r.body.path : 'New idea: ' + (r.body?.error || r.status), level: r.status === 201 ? 'ok' : 'bad' }, true);
      if (r.status === 201) outer.closeModal();
    };
  } else if (m.kind === 'guide') {
    // "Build it yourself" (M4): the shipped guide, and the way to the edit form.
    outer.$('#mdlT').textContent = 'Build it yourself';
    body.innerHTML = `<div class="msg agent notes-md" data-guide>${outer.guide ? md.parse(outer.guide.guide) : '<p class="muted">Loading the guide…</p>'}</div>`;
    if (!outer.guide) loadGuide();
    outer.$('#mdlFoot').innerHTML = '<span class="spacer"></span><button data-slot="button" data-guide-edit>Open the edit form</button>';
    outer.$('#mdlFoot [data-guide-edit]').onclick = () => outer.openModal({ kind: 'medit', items: editItems(outer.M) });
  } else if (m.kind === 'medit') {
    outer.$('#mdlT').textContent = 'Edit names and icons';
    // The form's code loads on its first open (shell-bundle.test.mjs BUDGET); after that it draws at once, so renderModal's scroll restore still holds.
    if (!editor) { body.innerHTML = '<p class="muted">Loading the edit form…</p>'; import('./mission-editor.mjs').then(x => { editor = x; outer.S.modal === m && outer.renderModal(); },
      () => { if (outer.S.modal !== m) return; // a failed load stays failed for this page, so the way out is a reload
        body.innerHTML = '<p>P9 could not load the edit form.</p><button data-slot="button" data-variant="outline" data-reload>Reload the window</button>';
        body.querySelector('[data-reload]').onclick = () => location.reload(); }); return true; }
    editor.editorModal(m, body, outer.$('#mdlFoot'), { mission: window.p9.mission, pick: window.p9.pickPicture, art: () => outer.M.art, esc, toast: outer.toast, again: () => outer.S.modal === m && outer.renderModal(),
      reload: async keep => { await refreshMission(); if (keep) outer.S.modal === m && outer.renderModal(); else outer.openModal({ kind: 'medit', items: editItems(outer.M) }); } });
  } else return false;
  return true;
}
  return { pullTopLevels, usage, loadUsage, pollUsage, usageNow, restartBtn, restartP9, loadMission, refreshMission, pollMission, queueSoon, noticeLine, listRow, answerLive, widgetOn, allNotes, usageBody, tokensSay, art, launchTile, winTop, winPanel, NEEDS, placed, placedCols, placedHtml, topRow, byFile, missionEmpty, missionIntro, loadGuide, renderSpaceBtn, bindOnboard, missionLive, noteKey, liveFileModal, noteFoot, saveNote, missionModal };
}
