// Sprint View: where a started sprint stands, for projects-view.mjs. Loaded when a started sprint's page opens, so its
// code is not parsed at startup (test/shell-bundle.test.mjs).
// It draws one answer: the body of GET /sprints/<id>/status, which is what the sprint_status tool gives an agent
// (apps/server/sprint-hooks.mjs, view). Nothing here counts on its own: every number on the page is in that answer.
const R = 16, C = +(2 * Math.PI * R).toFixed(2);
const ring = (done, total, label, kind = '') => `<span class="sv-ring ${kind}" role="img" aria-label="${label}"><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="t" cx="20" cy="20" r="${R}"/>${done && total ? `<circle class="a" cx="20" cy="20" r="${R}" stroke-dasharray="${+(C * Math.min(1, done / total)).toFixed(2)} ${C}"/>` : ''}</svg><b>${done}/${total}</b></span>`;
// 3 725 000 ms reads "1 h 2 min".
export const span = ms => { const m = Math.floor(ms / 60000), h = Math.floor(m / 60); return h ? `${h} h ${m % 60} min` : m ? `${m} min` : 'under a minute'; };
const WORD = { working: 'Working', idle: 'Idle', stopped: 'Stopped', failed: 'Failed' };
// What a worker's row says: a review's answer first, then a question to you, then what the chat is doing.
const stands = w => w.verdict?.result === 'fix' ? ['fix', 'Fix asked'] : w.waiting ? ['asked', 'Waiting for you'] : w.ready && !w.verdict ? ['ready', 'Ready for review'] : [w.state, WORD[w.state] ?? w.state];
const REVIEW = { passed: 'Passed', fix: 'Fix asked', ready: 'In review' };

export function statusHtml(s, esc) {
  const d = s.done, open = s.items.filter(i => i.review?.state !== 'passed'), n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const facts = [
    ['time', 'Running', s.running_ms === null ? 'Not started' : span(s.running_ms)],
    ['ticked', 'Ticked in the plan', `${d.ticked} of ${d.total}`],
    ['chats', 'Chats', String(s.workers.length)],
    ['scripts', 'Scripts', s.scripts.waiting ? `${s.scripts.running} running, ${s.scripts.waiting} waiting for you` : String(s.scripts.running)]]; // running already counts the additional ones
  return `<section class="sec sv" data-sv aria-label="Sprint View: ${esc(s.sprint.title ?? '')}">
    <div class="sv-top">${ring(d.passed, d.total, `${d.passed} of ${d.total} items passed review`, 'big')}
      <div class="sv-say"><b data-sv-done>${d.total ? `${d.passed} of ${n(d.total, 'item', 'items')} passed review` : 'The plan has no items yet'}</b>
        <span class="muted">${d.total ? (open.length ? `${n(open.length, 'item', 'items')} to go. An item counts when its review passes, not when its box is ticked.` : 'Every item passed its review.') : 'An item is a line "- [ ] id: what; role key" in sprint.md.'}</span></div>
      <dl class="sv-facts">${facts.map(([k, t, v]) => `<div><dt>${t}</dt><dd data-sv-fact="${k}">${esc(v)}</dd></div>`).join('')}</dl></div>
    <h3>Chats</h3>
    <ul class="sv-rows">${s.workers.map(w => { const [st, word] = stands(w), q = w.work;
      return `<li><button type="button" class="sv-row" data-chat="${esc(w.chat)}" data-sv-worker="${esc(w.key ?? '')}" data-status="${esc(st)}" title="Open this chat">${q && q.total ? ring(q.done, q.total, `${q.done} of ${q.total} of its items passed review`) : '<span class="sv-ring none" aria-hidden="true"></span>'}
        <span class="sv-main"><b>${esc(w.key ?? w.title ?? '')}</b><span class="muted">${esc([w.model, w.effort].filter(Boolean).join(' · '))}${Number.isFinite(w.context) ? ` · context ${Math.round(w.context)}%` : ''}</span></span>
        <span class="sv-item">${esc(w.task?.item ?? (q && q.total ? 'No item taken yet' : 'No items in the plan for this role'))}</span>
        <span class="tag" data-sv-state>${esc(word)}</span></button></li>`; }).join('')}</ul>
    ${s.items.length ? `<h3>Plan items</h3><ul class="sv-items">${s.items.map(i => `<li data-sv-item="${esc(i.id)}" data-review="${esc(i.review?.state ?? '')}"><span class="box" aria-hidden="true">${i.ticked ? '☑' : '☐'}</span><span class="sv-text">${esc(i.text)}</span><span class="muted">${esc(i.role ?? 'no role')}</span><span class="tag">${i.review ? esc((REVIEW[i.review.state] ?? i.review.state) + (i.review.fixes ? ` · ${n(i.review.fixes, 'fix', 'fixes')}` : '')) : i.ticked ? 'Ticked, not reviewed' : 'Open'}</span></li>`).join('')}</ul>` : ''}
  </section>`;
}
