// One folder sprint's review (daemon-3), loaded only when the modal opens so it stays out of the shell's startup JS.
import { esc } from './helpers.mjs';

export function sprintCopyModal(outer, m, body) {
  // One folder sprint's review. Applied: the three lists, partial marked partial, a reason for each path. Not applied: the
  // change to show, and the owner's yes for exactly that change; nothing is written without the press.
  outer.$('#mdlT').textContent = 'Folder sprint';
  outer.$('#mdlFoot').innerHTML = '';
  body.innerHTML = '<div class="review" data-copy-body><p class="sm muted">Loading…</p></div>';
  const paint = (html) => { const box = body.querySelector('[data-copy-body]'); if (box && outer.mdl.open && outer.S.modal === m) box.innerHTML = html; };
  const list = (title, items) => `<h3>${esc(title)}</h3>${items.length ? `<ul>${items.map(i => `<li><code>${esc(i)}</code></li>`).join('')}</ul>` : '<p class="sm muted">None.</p>'}`;
  const reasons = (title, items) => `<h3>${esc(title)}</h3>${items.length ? `<ul>${items.map(i => `<li><code>${esc(i.path)}</code>: ${esc(i.reason)}</li>`).join('')}</ul>` : '<p class="sm muted">None.</p>'}`;
  const refusal = (b) => esc(b?.refused || b?.error || b?.cause || 'refused');
  const show = async () => {
    const [view, pre] = await Promise.all([window.p9.mission('sprintClose', { id: m.id }), window.p9.mission('sprintPreview', { id: m.id })]);
    if (view.status === 200) {
      const v = view.body;
      // The sentences come from the server, derived from the three lists; a pending apply shows no lists (they are unknown).
      paint(`${(v.lines ?? []).map(l => `<p class="sm" role="status">${esc(l)}</p>`).join('')}`
        + (v.pending ? '' : `${list('Written', v.written)}${list('Rolled back', v.rolledBack)}${reasons('Left or failed', v.left)}`));
      return;
    }
    if (pre.status !== 200) return paint(`<p class="sm" role="status">Cannot show this copy: ${refusal(pre.body)}.</p>`);
    const p = pre.body, changes = p.changes.map(c => `${c.status} ${c.path}`);
    paint(`${list('Changes to apply to your folder', changes)}${reasons('Not copied from your folder', p.left ?? [])}`
      + `<p class="sm muted">Nothing is written until you press Apply. A file changed since this was shown is refused.</p>`
      + `<p class="sm" data-copy-msg></p>`);
    if (!changes.length) return;
    outer.$('#mdlFoot').innerHTML = '<button data-slot="button" data-copy-apply>Apply these changes</button>';
    outer.$('#mdlFoot [data-copy-apply]').onclick = async () => {
      const r = await window.p9.mission('sprintApply', { id: m.id, shown: p.shown });
      if (r.status === 200) { outer.$('#mdlFoot').innerHTML = ''; return show(); }
      const msg = body.querySelector('[data-copy-msg]'); if (msg) msg.textContent = 'Not applied: ' + refusal(r.body);
    };
  };
  show().catch(() => paint('<p class="sm" role="status">Cannot show this copy right now.</p>'));
}
