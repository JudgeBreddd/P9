// The Sprint window's body, loaded only when the window opens so it stays out of the shell's startup JS (O233).
import { esc, sprintTimes } from './helpers.mjs';

// The status file's rings when there is one, its error when it does not read, nothing about it when there is none; then
// the Folder sprints list.
const SPRINT_STATE = { running: 'running', waiting: 'waiting', merged: 'merged', blocked: 'blocked', unknown: 'unknown' };
const sprintOverall = d => Number.isFinite(d.overall) ? `<div class="spall"><div class="ring" role="img" aria-label="Whole sprint ${d.overall}%" style="--p:${d.overall}" data-overall><b>${d.overall}%</b></div><div class="spt"><b>Whole sprint</b><span class="sm muted">${d.chunks.filter(c => c.state === 'merged').length} of ${d.chunks.length} merged</span></div></div>` : '';
const sprintRings = d => `<div class="springs">${d.chunks.map(c => `<div class="spr" data-state="${esc(SPRINT_STATE[c.state] || 'unknown')}"><div class="ring" role="img" aria-label="${esc(c.id)} ${esc(c.state)} ${c.percent}%" style="--p:${c.percent}"><b>${c.percent}%</b></div><div class="spt"><b class="truncate">${esc(c.id)} · ${esc(c.title)}</b><span class="sm st">${esc(c.state)}${c.activity ? ` · <span data-activity="${esc(c.activity)}">${esc(c.activity)}</span>` : ''}${c.steps ? ` · <span data-steps>${esc(c.steps)}</span>` : ''}</span>${c.waitingOn && (c.state === 'waiting' || c.state === 'blocked') ? `<span class="sm wait">Waiting on: ${esc(c.waitingOn)}</span>` : ''}</div></div>`).join('') || '<p class="empty">No chunks in the status file yet.</p>'}</div>`;
export function sprintBody(outer, m, body) {
  const d = outer.SP.data;
  body.innerHTML = `<div class="review" data-sprint-body>${d ? `${sprintOverall(d)}<p class="sm muted" data-sprint-times>${esc(sprintTimes(d))}${Number.isFinite(d.overall) ? '' : ` · ${d.chunks.filter(c => c.state === 'merged').length} of ${d.chunks.length} merged`}</p>${sprintRings(d)}`
    : outer.SP.on ? `<p class="sm" role="status">The sprint status file is there but P9 cannot read it (${esc(outer.SP.error)}).</p>` : ''}${m.hint ? `<p class="sm" role="status">${esc(m.hint)}</p>` : ''}<div data-copies></div></div>`;
  return copiesBox(outer, m, body);
}
// The Sprint window's Folder sprints list (O233): it always says what it found and on which machine, so an empty list and a
// failed call are not both blank; each button names its folder. Each copy opens its review (SECURITY.md "Applying to your folder is a yes").
function copiesBox(outer, m, body) {
  const where = outer.serverInfo?.host || 'this computer', folder = c => (c.source || '').split(/[\\/]/).filter(Boolean).pop() || c.id;
  return window.p9.mission('sprintCopies').catch(e => ({ status: 0, body: { error: e?.message || String(e) } })).then(r => { const box = body.querySelector('[data-copies]'); if (!box) return;
    box.innerHTML = r.status !== 200 || !Array.isArray(r.body?.copies) ? `<p class="sm" role="status" data-copies-error>P9 could not list the folder sprints on ${esc(where)} (${esc(r.body?.error || r.status)}).</p>`
      : r.body.copies.length ? `<h3>Folder sprints</h3>${r.body.copies.map(c => `<button data-slot="button" data-variant="outline" data-copy="${esc(c.id)}">${c.applied ? 'Applied' : 'Review change'}: ${esc(folder(c))}</button>`).join(' ')}`
      : `<p class="sm muted" data-copies-none>No folder sprints on ${esc(where)}.</p>`;
    box.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => outer.openModal({ kind: 'sprintcopy', id: b.dataset.copy, back: m }));
  });
}

