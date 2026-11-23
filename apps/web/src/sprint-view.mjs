// Sprint View: where a started sprint stands, and Sprint Setup's Roles rows, for projects-view.mjs. Loaded when a sprint's page opens, so its
// code is not parsed at startup (test/shell-bundle.test.mjs).
// It draws one answer: the body of GET /sprints/<id>/status, which is what the sprint_status tool gives an agent
// (apps/server/sprint-hooks.mjs, view). Nothing here counts on its own: every number on the page is in that answer.
import { svg, runnerPicks, modes, LOOSE } from './helpers.mjs';
const R = 16, C = +(2 * Math.PI * R).toFixed(2);
const ring = (done, total, label, kind = '') => `<span class="sv-ring ${kind}" role="img" aria-label="${label}"><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="t" cx="20" cy="20" r="${R}"/>${done && total ? `<circle class="a" cx="20" cy="20" r="${R}" stroke-dasharray="${+(C * Math.min(1, done / total)).toFixed(2)} ${C}"/>` : ''}</svg><b>${done}/${total}</b></span>`;
// 3 725 000 ms reads "1 h 2 min".
// O162 (usage): the status answer's spent, the sum of the sprint's chats; compact counts, the cost only when one was reported.
// Also each worker row's own spent (spec I3, tokens used); a field not reported counts as 0.
const k = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const usedText = u => u === null ? 'Nothing reported yet' : `${k.format(u.inputTokens || 0)} in · ${k.format(u.outputTokens || 0)} out · ${k.format(u.cachedTokens || 0)} cached${u.costUsd > 0 ? ` · $${u.costUsd.toFixed(2)}` : ''}`;
export const span = ms => { const m = Math.floor(ms / 60000), h = Math.floor(m / 60); return h ? `${h} h ${m % 60} min` : m ? `${m} min` : 'under a minute'; };
const WORD = { working: 'Working', idle: 'Idle', stopped: 'Stopped', failed: 'Failed' };
// What a worker's row says: a review's answer first, then a question to you, then what the chat is doing.
const stands = w => w.verdict?.result === 'fix' ? ['fix', 'Fix asked'] : w.waiting ? ['asked', 'Waiting for you'] : w.ready && !w.verdict ? ['ready', 'Ready for review'] : [w.state, WORD[w.state] ?? w.state];
const REVIEW = { passed: 'Passed', fix: 'Fix asked', ready: 'In review' };

// I1: "N of N steps in phase X, N of N phases", from the plan's "## Phase" headings. A plan with none has no line.
function phaseLine(s, esc) {
  const ps = s.phases ?? [], now = ps[s.phase_now];
  if (!ps.length) return '';
  // A record saved before done meant merged (FIX1) carries passed counts, not merged ones: read either, never rewrite the record.
  const m = p => p.merged ?? p.passed ?? 0, done = ps.filter(p => m(p) >= p.total).length;
  const t = `${now ? `${m(now)} of ${now.total} steps in ${esc(now.title)}, ` : s.done.merged === undefined ? 'Every phase passed review: ' : 'Every phase merged: '}${done} of ${ps.length} phases`;
  return byPhase(s) ? `<button type="button" class="sv-phase" data-sv-phase data-sv-plan="${esc(s.sprint.id)}" aria-expanded="${planOpen.has(s.sprint.id)}" title="Show every item in its phase, then each phase in full">${t}</button>` : `<span class="sv-phase" data-sv-phase>${t}</span>`;
}
// I1 plan view: the phase line opens every item nested in its phase with its tick, then each phase's section in full (its
// checks and evidence, as sprint.md has them). A record saved before items carried a phase has none: the flat list only.
// Open stays open across the 5 s redraws: this module keeps which sprints are open and its own click listener, so the
// startup JS (projects-view.mjs) carries none of it.
const planOpen = new Set(), byPhase = s => s.phases?.length > 0 && s.items.some(i => 'phase' in i && !(s.owner && i.role === 'owner')); // as statusHtml's plan
globalThis.document?.addEventListener('click', e => {
  const b = e.target.closest?.('[data-sv-plan]'), v = b?.closest('.sv'), pv = v?.querySelector('[data-sv-planview]'); if (!pv) return;
  const id = b.dataset.svPlan, on = !planOpen.delete(id) && !!planOpen.add(id);
  b.setAttribute('aria-expanded', on); pv.hidden = !on; v.querySelector('[data-sv-flat]').hidden = on;
});
const planView = (s, plan, row, esc) => `<div data-sv-planview${planOpen.has(s.sprint.id) ? '' : ' hidden'}><h3>Plan by phase</h3>
      ${[...s.phases.map((p, k) => [p.title, plan.filter(i => i.phase === k)]), ['Outside every phase', plan.filter(i => i.phase == null)]].filter(([t, is], k) => is.length || k < s.phases.length)
        .map(([t, is]) => `<h4>${esc(t)}</h4>${is.length ? `<ul class="sv-items">${is.map(i => row(i, 'data-sv-pitem')).join('')}</ul>` : '<p class="hint">No items in this phase.</p>'}`).join('')}
      ${s.phases.some(p => typeof p.text === 'string') ? '<h3>Each phase in full</h3>' : ''}${s.phases.map(p => typeof p.text === 'string' ? `<section class="sv-ptext" data-sv-phasetext><h4>${esc(p.title)}</h4>${p.text ? `<pre>${esc(p.text)}</pre>` : p.truncated ? '' : '<p class="hint">Nothing is written under this heading.</p>'}${p.truncated ? '<p class="hint">Cut at 4000 characters here; the rest is in sprint.md.</p>' : ''}</section>` : '').join('')}</div>`;
// I3 worker window: Model or effort under a chat's row moves it to another model or effort from its next turn. It goes as a
// message you send that chat (its own pick path, chat.mjs prompt), queued, so a running turn keeps its own and the message
// waits for its end (O133). The page cannot call send_chat: that is the lead's path (#436), open only to a worker's parent.
// o: the shell's agent lists (projects-view.mjs). picks: per chat, open or not, the values picked and what came back, kept
// across the 5 s redraws; this module's own listeners, so the startup JS carries none of it.
const picks = new Map(), pk = id => picks.get(id) ?? (picks.set(id, {}), picks.get(id));
const flat = xs => xs.flatMap(x => Array.isArray(x.options) ? flat(x.options) : [[x.value, x.name]]);
function repick(w, o, esc) {
  const k = pk(w.chat), a = w.profile ? 'claude' : w.provider, ep = o.lastPickers[a]?.find(p => o.pickerKind(p) === 'effort');
  const sel = (kind, opts, now, pick = now, more = '') => opts.length ? `<label class="set-pick">${kind[0].toUpperCase() + kind.slice(1)}<select data-slot="input" data-sv-r="${kind}" data-now="${esc(now ?? '')}"${more}${k.busy ? ' disabled' : ''} aria-label="${esc(`${w.key ?? w.title} ${kind}`)}">${(now && !opts.some(([v]) => v === now) ? [[now, now], ...opts] : opts).map(([v, n]) => `<option value="${esc(v)}"${v === pick ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>` : '';
  // data-now: what it runs on, so Send compares against that, not against a pick kept across a redraw.
  // A provider profile chat keeps the model it started on (SECURITY.md § Delegate, I3): effort only.
  const body = (w.profile ? '' : sel('model', flat(o.lastModels[a]?.options ?? []), w.model, k.model ?? w.model))
    + (ep ? sel('effort', flat(ep.options ?? []), w.effort, k.effort ?? w.effort, ` data-id="${esc(ep.id)}"`) : '');
  return `<button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-sv-pick aria-expanded="${!!k.open}" title="Moves this chat to another model or effort from its next turn, with a message from you">Model or effort</button>`
    + `<div class="sv-repick" data-sv-repick${k.open ? '' : ' hidden'}>${body ? body + `<button type="button" data-slot="button" data-variant="outline" data-size="sm" data-sv-apply${k.busy ? ' disabled' : ''}>Send with a message</button>` : `<span class="hint">Start one ${esc(o.names[a] ?? a)} chat first: its models and efforts are listed here after that.</span>`}<span class="hint" data-sv-said role="status">${esc(k.said ?? '')}</span></div>`;
}
globalThis.document?.addEventListener('change', e => { const x = e.target.closest?.('[data-sv-r]'), id = x?.closest('li[data-key]')?.dataset.key; if (id) pk(id)[x.dataset.svR] = x.value; });
globalThis.document?.addEventListener('click', e => {
  const b = e.target.closest?.('[data-sv-pick], [data-sv-apply]'), li = b?.closest('li[data-key]'); if (!li) return;
  const k = pk(li.dataset.key), f = li.querySelector('[data-sv-repick]'), said = t => { k.said = t; f.querySelector('[data-sv-said]').textContent = t; };
  if (b.dataset.svPick !== undefined) { k.open = f.hidden; f.hidden = !k.open; return b.setAttribute('aria-expanded', k.open); }
  // Only what you picked and changed is sent: a select showing what the chat runs on, or with none known only its first option,
  // sends nothing. While a send is out the picks are disabled (kept through the redraw by busy), so the 202's clear loses no newer pick.
  const got = x => x && k[x.dataset.svR] !== undefined && x.value !== x.dataset.now ? x.value : '', mx = f.querySelector('[data-sv-r="model"]'), ef = f.querySelector('[data-sv-r="effort"]'), m = got(mx), e2 = got(ef);
  if (!m && !e2) return said('Pick another model or effort first.');
  const to = [mx?.value, ef?.value].filter(Boolean).join(' · ');
  const lock = on => { b.disabled = k.busy = on; f.querySelectorAll('[data-sv-r]').forEach(x => { x.disabled = on; }); };
  lock(true); said('Sending…');
  window.p9.chat('prompt', { id: li.dataset.key, when: 'queue', text: `You now run on ${to} (changed by the owner in the Sprint View), from this turn on. Carry on with your work.`,
    ...(m && { model: m }), ...(e2 && { config: { [ef.dataset.id]: e2 } }) })
    .then(r => r.status === 202 ? (delete k.model, delete k.effort, `Sent: ${to} from its next turn.`) : `Not sent: ${r.body?.error || r.status}.`, e => `Not sent: ${e?.message || e}.`)
    .then(t => { said(t); lock(false); });
});
// Close sprint: the closed page's words and the press (projects-view.mjs), here with the button statusHtml draws so the
// shell's startup JS does not carry them. closePress answers null for a Cancel, '' for closed, else why it was refused;
// out() is called once the press is going out.
export const closedAbout = 'This sprint is closed. Its record is first: what it built and its numbers, as they stood at Close; an agent reads the same with sprint_status. Its files are below, read only.';
// b: the pressed button. One with data-item is the Close on one of the owner's own lines (O164 part (3)): it closes only
// that line, with no confirm (nothing stops) and no out(); P9 records the click, no merge or review is involved.
export async function closePress(b, confirmIt, call, out, got) { // got(answer): Close's answer, which says what it cleaned up
  const lead = b.dataset.lead, item = b.dataset.item, said = r => r.status === 200 ? '' : 'Not closed: ' + (r.body?.detail || r.body?.error || r.status || 'no answer');
  if (item) return said(await call('ownerDone', { sprint: lead, item }, { quiet: true }).catch(() => ({})));
  if (!await confirmIt({ title: 'Close this sprint?', body: 'Every chat of this sprint is stopped, its record is kept and its scripts are turned off. Worker folders with nothing unsaved whose work is merged are removed; the rest and the sprint\'s files stay. A closed sprint is not started again.', ok: 'Close sprint', danger: true })) return null;
  out();
  const r = await call('closeSprint', { sprint: lead }, { quiet: true }).catch(() => ({})); got?.(r);
  return said(r);
}
export function statusHtml(s, esc, opts = {}, o = null) {
  // O164 part (3) FIX1: owner lines leave the worker counts and the Plan list only where the record has its owner
  // projection (s.owner); a record saved before it keeps every row as it stood.
  const d = s.done, legacy = d.merged === undefined, dn = d.merged ?? d.passed ?? 0, plan = s.owner ? s.items.filter(i => i.role !== 'owner') : s.items,
    open = legacy ? plan.filter(i => i.review?.state !== 'passed') : plan.filter(i => i.review?.merged !== true),
    n = (k, one, many) => `${k} ${k === 1 ? one : many}`, doneWord = legacy ? 'passed review' : 'merged';
  // closed: the answer is the sprint's record, as it stood at Close. opts.closing: a Close press is out; opts.said: why the last one was refused.
  const end = s.closed, when = end ? new Date(end.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const facts = [
    ['time', end ? 'Ran' : 'Running', s.running_ms === null ? 'Not started' : span(s.running_ms)],
    ['ticked', 'Ticked in the plan', `${d.ticked} of ${d.total}`],
    ['chats', 'Chats', String(s.workers.length)],
    ['scripts', 'Scripts', s.scripts.waiting ? `${s.scripts.running} running, ${s.scripts.waiting} waiting for you` : String(s.scripts.running)], // running already counts the additional ones
    // O162: a record closed before PRs an hour was counted has no such number, so no row.
    ...('prs_per_hour' in s ? [['rate', 'PRs an hour', s.prs_per_hour === null ? 'Not started' : String(s.prs_per_hour)]] : []),
    // O162: a record closed before the usage total was counted has none, so no row.
    ...('spent' in s ? [['spent', 'Used', usedText(s.spent)]] : [])];
  const row = (i, a = 'data-sv-item') => `<li ${a}="${esc(i.id)}" data-review="${esc(i.review?.state ?? '')}"><span class="box" aria-hidden="true">${i.ticked ? '☑' : '☐'}</span><span class="sv-text">${esc(i.text)}</span><span class="muted">${esc(i.role ?? 'no role')}</span><span class="tag">${i.review ? esc((REVIEW[i.review.state] ?? i.review.state) + (i.review.fixes ? ` · ${n(i.review.fixes, 'fix', 'fixes')}` : '')) : i.ticked ? 'Ticked, not reviewed' : 'Open'}</span></li>`;
  return `<section class="sec sv" data-sv="${end ? 'closed' : 'open'}" aria-label="${end ? 'Closed sprint' : 'Sprint View'}: ${esc(s.sprint.title ?? '')}">
    <div class="sv-top">${ring(dn, d.total, `${dn} of ${d.total} items ${doneWord}`, 'big')}
      <div class="sv-say"><b data-sv-done>${d.total ? `${dn} of ${n(d.total, 'item', 'items')} ${doneWord}` : 'The plan has no items yet'}</b>
        <span class="muted">${d.total ? (legacy ? `This record was saved before done meant merged: these counts are its reviews, not merge evidence.${open.length ? ` ${n(open.length, 'item', 'items')} never passed review.` : ''}` : (open.length ? `${n(open.length, 'item', 'items')} to go. An item counts when its work reaches the main line, not when its box is ticked or its review passes.` : 'Every item\'s work is in the main line.')) : 'An item is a line "- [ ] id: what; role key" in sprint.md.'}${d.unproven ? ` ${n(d.unproven, 'item', 'items')} cannot be proven merged: P9 holds no clone or copy of this repo.` : ''}</span>${phaseLine(s, esc)}</div>
      <dl class="sv-facts">${facts.map(([k, t, v]) => `<div><dt>${t}</dt><dd data-sv-fact="${k}">${esc(v)}</dd></div>`).join('')}</dl></div>
    ${end ? `<p class="hint" data-sv-closed>Closed ${esc(when)} by ${end.by === 'owner' ? 'you' : 'a chat\'s agent, on your yes'}. This is its record: everything here is as it stood at Close and no longer changes. Its chats are stopped; its files stay, and so do the worker folders Close kept (work not saved or not yet in the main line).</p>`
      : `<div class="sv-ctl"><button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-pj="spclose" data-lead="${esc(s.sprint.id)}"${opts.closing ? ' disabled' : ''} title="Stops every chat of this sprint, keeps its record, turns its scripts off and removes its finished worker folders (merged, nothing unsaved). An agent does the same with close_sprint, after asking you.">${opts.closing ? 'Closing…' : 'Close sprint'}</button>${opts.said ? `<span class="hint" data-sv-said role="status">${esc(opts.said)}</span>` : ''}</div>`}
    <h3>Chats</h3>
    <ul class="sv-rows">${s.workers.map(w => { const [st, word] = stands(w), q = w.work;
      return `<li data-key="${esc(w.chat)}"><button type="button" class="sv-row" data-chat="${esc(w.chat)}" data-sv-worker="${esc(w.key ?? '')}" data-status="${esc(st)}" title="Open this chat">${q && q.total ? ring(q.done, q.total, `${q.done} of ${q.total} of its items ${doneWord}`) : '<span class="sv-ring none" aria-hidden="true"></span>'}
        <span class="sv-main"><b>${esc(w.key ?? w.title ?? '')}</b><span class="muted">${esc([w.model, w.effort].filter(Boolean).join(' · '))}${Number.isFinite(w.context) ? ` · context ${Math.round(w.context)}%` : ''}${w.spent ? ' · ' + usedText(w.spent) : ''}</span></span>
        <span class="sv-item">${esc(w.task?.item ?? (q && q.total ? (q.next ? 'Next: ' + q.next : q.next === null ? 'All its items passed review' : 'No item taken yet') : 'No items in the plan for this role'))}</span>
        <span class="tag" data-sv-state>${esc(word)}</span></button>${!end && o ? repick(w, o, esc) : ''}</li>`; }).join('')}</ul>
    ${s.owner && s.owner.total ? `<h3>Your items</h3><ul class="sv-rows"><li class="sv-owner-row" data-sv-owner>${ring(s.owner.done, s.owner.total, `${s.owner.done} of ${s.owner.total} of your items closed`)}
      <ul class="sv-items">${s.owner.items.map(i => `<li data-sv-item="${esc(i.id)}" data-owner="${i.done ? 'closed' : 'open'}"><span class="sv-text">${esc(i.text)}</span>${i.done ? '<span class="tag">Closed by you</span>' : end ? '<span class="tag">Open at Close</span>' : `<button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-pj="spclose" data-lead="${esc(s.sprint.id)}" data-item="${esc(i.id)}" title="Closes this item. It is yours: no review and no merge is involved, and the plan's box stays as it is.">Close</button>`}</li>`).join('')}</ul></li></ul>` : ''}
    ${plan.length ? `<div data-sv-flat${byPhase(s) && planOpen.has(s.sprint.id) ? ' hidden' : ''}><h3>Plan items</h3><ul class="sv-items">${plan.map(i => row(i)).join('')}</ul></div>${byPhase(s) ? planView(s, plan, row, esc) : ''}` : ''}
  </section>`;
}

// H2 (SECURITY.md § Standing merge): the owner's switch, on Sprint Setup; only this page sets it, no agent tool does.
export const mergeHtml = (sp, esc) => sp.closed ? '' : `<label class="set-pick" data-sp-merge title="On: the lead may merge a PR that passed review, once the sprint's before-merge scripts allow it. Off: the lead is told merge is yours and asks you. A new sprint starts with it off; a sprint made before this switch existed keeps merge on. It binds a lead that reports before it merges (sprint_event), as the sprint rules tell it to; it cannot stop git itself."><input type="checkbox" data-pj="spmerge" data-lead="${esc(sp.lead)}"${sp.merge ? ' checked' : ''}> Standing merge: the lead may merge</label>`;
// H1-H3: Sprint Setup's Roles rows, for projects-view.mjs (moved here so they are not parsed at startup:
// test/shell-bundle.test.mjs). roles: the parsed roles.json list, null when it does not read.
const rolesWhy = sp => { const t = sp.files.find(f => f.name === 'roles.json')?.text;
  if (t == null) return 'it is missing'; if (!t.trim()) return 'it is empty'; try { const d = JSON.parse(t); return Array.isArray(d?.roles) ? 'a row has no "key"' : 'it has no "roles" list'; } catch (e) { return e.message; } };
const ROLE = { lead: 'Lead: runs the sprint, merges what passed review', review: 'Reviewer: reviews each piece, gets no worker folder' };
// H2 (the setup window): each Setup file an agent wrote, or one changed outside P9's Setup tools, until the owner has seen
// that text: "Written by <writer> · not seen" and a Seen press. Its click is handled here, so the page's startup code
// is unchanged. A file changed since the page showed it is refused (409) and its mark comes back with the new text.
const shown = new Map();
let bound = false;
function marksHtml(sp, o, esc) {
  shown.set(sp.lead, sp);
  if (!bound) { bound = true; document.addEventListener('click', e => seenPress(e.target.closest?.('[data-sp-seen]'), o)); }
  return sp.files.filter(f => f.unseen).map(f => `<p class="hint" data-sp-mark="${esc(f.name)}"><span class="mono">${esc(f.name)}</span>: Written by ${esc(f.unseen)} · not seen <button data-slot="button" data-variant="outline" data-size="sm" data-sp-seen data-lead="${esc(sp.lead)}" data-name="${esc(f.name)}" data-hash="${esc(f.hash)}">Seen</button></p>`).join('');
}
async function seenPress(b, o) {
  if (!b || b.disabled) return;
  const { lead, name, hash } = b.dataset;
  b.disabled = true;
  const r = await o.liveChat.call('sprintSeen', { sprint: lead, name, hash }, { quiet: true }).catch(() => null);
  if (r?.status === 200) { const f = shown.get(lead)?.files.find(x => x.name === name && x.hash === hash); if (f) delete f.unseen; b.closest('[data-sp-mark]')?.remove(); return; }
  b.disabled = false;
  b.textContent = r?.status === 409 ? 'Changed since: look again' : 'Not saved: try again';
}
export function rolesHtml(sp, roles, o, esc) { return marksHtml(sp, o, esc) + rolesBody(sp, roles, o, esc); }
function rolesBody(sp, roles, o, esc) {
  // A prep is made with its roles.json, so one gone was deleted: it says so, and the file is listed to make again
  // (FIX1). Any other sprint folder (a chat's notes, made without one) shows no roles.
  if (!sp.prep && !sp.files.some(f => f.name === 'roles.json')) return '';
  if (!roles) return `<p class="hint" data-sp-roles-bad role="status">roles.json does not read: <span class="mono" data-sp-roles-why>${esc(rolesWhy(sp))}</span>. Fix it in its file below; the rows show again when it reads.</p>`;
  const row = r => { const worker = r.key !== 'lead' && r.key !== 'review', p = runnerPicks(o, { agent: String(r.provider ?? ''), model: String(r.model ?? ''), effort: String(r.effort ?? '') },
    { first: ['', 'Not set'], attr: k => `data-spr="${k}" data-role="${esc(r.key)}" data-lead="${esc(sp.lead)}"`, aria: k => `${r.key} ${k}` });
    // H3: its permissions (the mode Start opens it in; Not set: P9's usual one) and what it owns, for the lead to send work by.
    const mode = String(r.mode ?? ''), ms = modes[p.a] ?? [], mo = [['', 'Not set'], ...ms.map(m => [m, m]), ...(mode && !ms.includes(mode) ? [[mode, mode]] : [])];
    const pick = r.provider ? `<label class="set-pick">Mode<select data-slot="input" data-spr="mode" data-role="${esc(r.key)}" data-lead="${esc(sp.lead)}" aria-label="${esc(r.key)} mode"${LOOSE[mode] ? ` title="${esc(LOOSE[mode])}"` : ''}>${mo.map(([v, n]) => `<option value="${esc(v)}"${v === mode ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>` : '';
    return `<div class="set-row sp-role" data-role-row="${esc(r.key)}"><span><strong class="mono">${esc(r.key)}</strong><span class="muted sm">${ROLE[r.key] ?? `Worker: its own folder on branch sprint/…/${esc(r.key)}`}${p.empty ? `. Start one ${esc(o.names[p.a] ?? p.a)} chat first: its models and efforts are listed here after that.` : ''}</span></span>${p.html}`
      + (worker ? `<button class="rm" data-pj="sprole-rm" data-lead="${esc(sp.lead)}" data-role="${esc(r.key)}" title="Remove the role ${esc(r.key)}" aria-label="Remove the role ${esc(r.key)}">${svg.x}</button>` : '')
      + `<span class="sp-role2"><label class="set-pick sp-owns">Owns<input data-slot="input" data-sp-owns data-role="${esc(r.key)}" data-lead="${esc(sp.lead)}" maxlength="500" spellcheck="false" autocomplete="off" placeholder="for example: the window, Settings" aria-label="${esc(r.key)} owns" value="${esc(String(r.owns ?? ''))}"></label>${pick}</span></div>`; };
  return `<div class="sp-roles" data-sp-roles><h3>Roles</h3>${roles.map(row).join('')}`
    + `<div class="sp-add"><input data-slot="input" class="mono" data-sp-newkey data-lead="${esc(sp.lead)}" maxlength="64" spellcheck="false" autocomplete="off" placeholder="worker name, for example docs" aria-label="New worker's name"><button data-slot="button" data-variant="ghost" data-size="sm" data-pj="sprole-add" data-lead="${esc(sp.lead)}">${svg.plus}Add worker</button></div></div>`;
}
