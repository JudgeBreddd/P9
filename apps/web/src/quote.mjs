// A2 step 6: quote a reply, or the part of it selected, with a comment. Loads on first use (chat-view.mjs quote, the
// phone's too). The box opens just under the selection, or above it when the window has no room below, inside host (the
// chat's dialog when the chat is in one, so it is not behind it). Enter adds the quote, with what was typed as its comment,
// to the message box as a chip; Esc, Cancel, a click outside or the focus leaving it closes it, and back() gets the focus.
// The box takes the focus, and with it the page's selection: Ctrl+C in it with nothing selected copies the whole selection.
// ponytail: one length, 8000 characters (an agent reply rarely runs longer); a longer quote is cut, with an ellipsis.
const MAX = 8000;
let shut = null, n = 0;
export function quoteBox({ rect, text: whole, add, host = document.body, back }) {
  shut?.();
  const text = whole.length > MAX ? whole.slice(0, MAX) + '…' : whole, id = 'quote-' + ++n;
  const box = Object.assign(document.createElement('form'), { className: 'quote-box' });
  box.setAttribute('aria-label', 'Comment on a quote');
  box.innerHTML = `<blockquote id="${id}"></blockquote><textarea rows="2" aria-label="Comment" aria-describedby="${id}" placeholder="Comment (optional)"></textarea><div class="quote-bar"><button type="button">Cancel</button><button type="submit">Comment</button></div>`;
  box.firstChild.textContent = text;
  const ta = box.querySelector('textarea'), ac = new AbortController();
  host.append(box);
  const h = box.offsetHeight, w = box.offsetWidth;
  box.style.left = Math.max(8, Math.min(rect.left, innerWidth - w - 8)) + 'px';
  box.style.top = (rect.bottom + 4 + h <= innerHeight - 8 ? rect.bottom + 4 : Math.max(8, rect.top - 4 - h)) + 'px';
  const close = shut = (refocus) => { ac.abort(); box.remove(); if (shut === close) shut = null; if (refocus) back?.(); };
  box.onsubmit = e => { e.preventDefault(); close(); add({ text, comment: ta.value.trim() }); };
  box.querySelector('[type=button]').onclick = () => close(true);
  box.onkeydown = e => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(true); } };
  ta.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); box.requestSubmit(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && ta.selectionStart === ta.selectionEnd) navigator.clipboard?.writeText(whole).catch(() => {});
  };
  // Tab or a shortcut taking the focus out (to another chat, say) closes it as a click outside does.
  box.addEventListener('focusout', e => { if (e.relatedTarget && !box.contains(e.relatedTarget)) close(); }, { signal: ac.signal });
  document.addEventListener('pointerdown', e => { if (!box.contains(e.target)) close(); }, { capture: true, signal: ac.signal });
  ta.focus();
  return box;
}
