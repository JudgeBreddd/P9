// Sprint View: where a started sprint stands, and Sprint Setup's Roles rows, for projects-view.mjs. Loaded when a sprint's page opens, so its
// code is not parsed at startup (test/shell-bundle.test.mjs).
// It draws one answer: the body of GET /sprints/<id>/status, which is what the sprint_status tool gives an agent
// (apps/server/sprint-hooks.mjs, view). Nothing here counts on its own: every number on the page is in that answer.
import { svg, runnerPicks, modes, LOOSE } from './helpers.mjs';
const R = 16, C = +(2 * Math.PI * R).toFixed(2);
const ring = (done, total, label, kind = '') => `<span class="sv-ring ${kind}" role="img" aria-label="${label}"><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="t" cx="20" cy="20" r="${R}"/>${done && total ? `<circle class="a" cx="20" cy="20" r="${R}" stroke-dasharray="${+(C * Math.min(1, done / total)).toFixed(2)} ${C}"/>` : ''}</svg><b>${done}/${total}</b></span>`;
// 3 725 000 ms reads "1 h 2 min".
export const span = ms => { const m = Math.floor(ms / 60000), h = Math.floor(m / 60); return h ? `${h} h ${m % 60} min` : m ? `${m} min` : 'under a minute'; };
const WORD = { working: 'Working', idle: 'Idle', stopped: 'Stopped', failed: 'Failed' };
// What a worker's row says: a review's answer first, then a question to you, then what the chat is doing.
const stands = w => w.verdict?.result === 'fix' ? ['fix', 'Fix asked'] : w.waiting ? ['asked', 'Waiting for you'] : w.ready && !w.verdict ? ['ready', 'Ready for review'] : [w.state, WORD[w.state] ?? w.state];
const REVIEW = { passed: 'Passed', fix: 'Fix asked', ready: 'In review' };

// I1: "N of N steps in phase X, N of N phases", from the plan's "## Phase" headings. A plan with none has no line.
function phaseLine(s, esc) {
  const ps = s.phases ?? [], now = ps[s.phase_now];
  if (!ps.length) return '';
  const done = ps.filter(p => p.merged >= p.total).length;
  return `<span class="sv-phase" data-sv-phase>${now ? `${now.merged} of ${now.total} steps in ${esc(now.title)}, ` : 'Every phase merged: '}${done} of ${ps.length} phases</span>`;
}
// Close sprint: the closed page's words and the press (projects-view.mjs), here with the button statusHtml draws so the
// shell's startup JS does not carry them. closePress answers null for a Cancel, '' for closed, else why it was refused;
// out() is called once the press is going out.
export const closedAbout = 'This sprint is closed. Its record is first: what it built and its numbers, as they stood at Close; an agent reads the same with sprint_status. Its roles and files are below.';
export async function closePress(lead, confirmIt, call, out) {
  if (!await confirmIt({ title: 'Close this sprint?', body: 'Every chat of this sprint is stopped, its record is kept and its scripts are turned off. Nothing is deleted. A closed sprint is not started again.', ok: 'Close sprint', danger: true })) return null;
  out();
  const r = await call('closeSprint', { sprint: lead }, { quiet: true }).catch(() => ({}));
  return r.status === 200 ? '' : 'Not closed: ' + (r.body?.detail || r.body?.error || r.status || 'no answer');
}
export function statusHtml(s, esc, opts = {}) {
  const d = s.done, open = s.items.filter(i => i.review?.merged !== true), n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  // closed: the answer is the sprint's record, as it stood at Close. opts.closing: a Close press is out; opts.said: why the last one was refused.
  const end = s.closed, when = end ? new Date(end.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const facts = [
    ['time', end ? 'Ran' : 'Running', s.running_ms === null ? 'Not started' : span(s.running_ms)],
    ['ticked', 'Ticked in the plan', `${d.ticked} of ${d.total}`],
    ['chats', 'Chats', String(s.workers.length)],
    ['scripts', 'Scripts', s.scripts.waiting ? `${s.scripts.running} running, ${s.scripts.waiting} waiting for you` : String(s.scripts.running)]]; // running already counts the additional ones
  return `<section class="sec sv" data-sv="${end ? 'closed' : 'open'}" aria-label="${end ? 'Closed sprint' : 'Sprint View'}: ${esc(s.sprint.title ?? '')}">
    <div class="sv-top">${ring(d.merged, d.total, `${d.merged} of ${d.total} items merged`, 'big')}
      <div class="sv-say"><b data-sv-done>${d.total ? `${d.merged} of ${n(d.total, 'item', 'items')} merged` : 'The plan has no items yet'}</b>
        <span class="muted">${d.total ? (open.length ? `${n(open.length, 'item', 'items')} to go. An item counts when its work reaches the main line, not when its box is ticked or its review passes.` : 'Every item\'s work is in the main line.') : 'An item is a line "- [ ] id: what; role key" in sprint.md.'}</span>${phaseLine(s, esc)}</div>
      <dl class="sv-facts">${facts.map(([k, t, v]) => `<div><dt>${t}</dt><dd data-sv-fact="${k}">${esc(v)}</dd></div>`).join('')}</dl></div>
    ${end ? `<p class="hint" data-sv-closed>Closed ${esc(when)} by ${end.by === 'owner' ? 'you' : 'a chat\'s agent, on your yes'}. This is its record: everything here is as it stood at Close and no longer changes. Its chats are stopped; its files and worker folders are kept.</p>`
      : `<div class="sv-ctl"><button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-pj="spclose" data-lead="${esc(s.sprint.id)}"${opts.closing ? ' disabled' : ''} title="Stops every chat of this sprint, keeps its record and turns its scripts off. Nothing is deleted. An agent does the same with close_sprint, after asking you.">${opts.closing ? 'Closing…' : 'Close sprint'}</button>${opts.said ? `<span class="hint" data-sv-said role="status">${esc(opts.said)}</span>` : ''}</div>`}
    <h3>Chats</h3>
    <ul class="sv-rows">${s.workers.map(w => { const [st, word] = stands(w), q = w.work;
      return `<li><button type="button" class="sv-row" data-chat="${esc(w.chat)}" data-sv-worker="${esc(w.key ?? '')}" data-status="${esc(st)}" title="Open this chat">${q && q.total ? ring(q.done, q.total, `${q.done} of ${q.total} of its items merged`) : '<span class="sv-ring none" aria-hidden="true"></span>'}
        <span class="sv-main"><b>${esc(w.key ?? w.title ?? '')}</b><span class="muted">${esc([w.model, w.effort].filter(Boolean).join(' · '))}${Number.isFinite(w.context) ? ` · context ${Math.round(w.context)}%` : ''}</span></span>
        <span class="sv-item">${esc(w.task?.item ?? (q && q.total ? 'No item taken yet' : 'No items in the plan for this role'))}</span>
        <span class="tag" data-sv-state>${esc(word)}</span></button></li>`; }).join('')}</ul>
    ${s.items.length ? `<h3>Plan items</h3><ul class="sv-items">${s.items.map(i => `<li data-sv-item="${esc(i.id)}" data-review="${esc(i.review?.state ?? '')}"><span class="box" aria-hidden="true">${i.ticked ? '☑' : '☐'}</span><span class="sv-text">${esc(i.text)}</span><span class="muted">${esc(i.role ?? 'no role')}</span><span class="tag">${i.review ? esc((REVIEW[i.review.state] ?? i.review.state) + (i.review.fixes ? ` · ${n(i.review.fixes, 'fix', 'fixes')}` : '')) : i.ticked ? 'Ticked, not reviewed' : 'Open'}</span></li>`).join('')}</ul>` : ''}
  </section>`;
}

// H1-H3: Sprint Setup's Roles rows, for projects-view.mjs (moved here so they are not parsed at startup:
// test/shell-bundle.test.mjs). roles: the parsed roles.json list, null when it does not read.
const rolesWhy = sp => { const t = sp.files.find(f => f.name === 'roles.json')?.text;
  if (t == null) return 'it is missing'; if (!t.trim()) return 'it is empty'; try { const d = JSON.parse(t); return Array.isArray(d?.roles) ? 'a row has no "key"' : 'it has no "roles" list'; } catch (e) { return e.message; } };
const ROLE = { lead: 'Lead: runs the sprint, merges what passed review', review: 'Reviewer: reviews each piece, gets no worker folder' };
export function rolesHtml(sp, roles, o, esc) {
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
