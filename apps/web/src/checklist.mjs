// Mission checklists (threat model row M4-a), drawn the same on the desktop and the phone: each file's rows with one button
// per mark (aria-pressed on the row's mark now), its review words, and Apply, which asks a second press before it runs.
// Every value from the file goes through esc. The daemon checks every write again; these only say what was pressed.
const WORDS = {
  'outside-workspace': 'Its folder is outside the workspace, so Mission does not open it.',
  'unknown-root': 'Its folder is not allowed yet: ask the setup chat to allow it (allow_folder), then say yes.',
  'root-refused': 'Mission does not open this folder: it holds the workspace or P9\'s own files.',
  'root-not-found': 'Its folder is not there.',
  'not-found': 'Not found: the file or folder is not there.',
  'hash-conflict': 'The file changed on disk since it was shown. It is shown again; nothing was written.',
  'not-pending': 'Apply works only while the review line reads pending. Nothing was written.',
  'review-line-count': 'This file has no review line or more than one, so Mission changes none of them.',
};
export const checklistWords = (code) => WORDS[code] || 'Not done (' + code + ').';

// r: the daemon's reply ({ files, marks, review, apply }, optionally with note: the last refusal), { error }, or nothing yet.
// armed: the "id\npath" whose Apply was pressed once.
export function checklistHtml(id, r, esc, armed = '') {
  if (!r) return '<p class="tile-note">Loading…</p>';
  if (r.error) return `<p class="tile-note">${esc(checklistWords(r.error))}</p>`;
  const note = r.note ? `<p class="tile-note ck-note" role="status">${esc(checklistWords(r.note))}</p>` : '';
  if (!r.files.length) return note + '<p class="tile-note">Nothing to review.</p>';
  return note + r.files.map((f, i) => {
    const key = id + '\n' + f.path, marks = r.marks ? Object.entries(r.marks) : [];
    return `<div class="ck-file" data-ck-file="${i}"><p class="ck-name"><b>${esc(f.name)}</b>`
      + (f.review !== null || r.review ? `<span class="ck-state" data-ck-review>${f.review === null ? 'review line unclear' : 'review: ' + esc(f.review)}</span>` : '') + '</p>'
      + (r.review ? `<div class="ck-marks" role="group" aria-label="Review ${esc(f.name)}">${r.review.map((w) => `<button type="button" data-ck-word="${esc(w)}" aria-pressed="${f.review === w}">${esc(w)}</button>`).join('')}</div>` : '')
      + (marks.length ? (f.rows.length ? `<ol class="ck-rows">${f.rows.map((x) => `<li data-ck-row="${x.n}"><p>${esc(x.text)}</p><div class="ck-marks" role="group" aria-label="${esc(x.text.slice(0, 80))}">`
        + marks.map(([k, label]) => `<button type="button" data-ck-mark="${esc(k)}" aria-pressed="${x.mark === k}">${esc(label)}</button>`).join('') + '</div></li>').join('')}</ol>`
        : '<p class="tile-note">No rows to mark.</p>') : '')
      + (r.apply && f.review === 'pending' ? `<button type="button" class="ck-apply" data-ck-apply${armed === key ? ' data-armed' : ''}>${armed === key ? 'Apply: press again to run it' : 'Apply'}</button>` : '')
      + '</div>';
  }).join('');
}

// A pressed button inside [data-ck]: { body } to POST /mission/checklist, { arm } after Apply's first press, or null.
export function checklistAction(button, r, armed) {
  const file = r?.files?.[Number(button.closest('[data-ck-file]')?.dataset.ckFile)];
  if (!file) return null;
  const id = button.closest('[data-ck]').dataset.ck, base = { id, path: file.path, hash: file.hash };
  if (button.dataset.ckMark !== undefined) return { body: { ...base, row: Number(button.closest('[data-ck-row]').dataset.ckRow), mark: button.dataset.ckMark } };
  if (button.dataset.ckWord !== undefined) return { body: { ...base, review: button.dataset.ckWord } };
  if (button.dataset.ckApply === undefined) return null;
  return armed === id + '\n' + file.path ? { body: { ...base, apply: true } } : { arm: id + '\n' + file.path };
}

// The daemon's reply to a checklist read, as checklistHtml takes it.
export const checklistAnswer = (status, body) => (status === 200 ? body : { error: body?.error || String(status) });
