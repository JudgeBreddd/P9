// A2 step 6: quote a reply, or the part of it selected, with a comment. Loads on first use (chat-view.mjs quote, the
// phone's too). The box opens just under the selection, or above it when the window has no room below. Enter adds the
// quote, with what was typed as its comment, to the message box as a chip; Esc, Cancel or a click outside closes it.
// The box takes the focus, and with it the page's selection: Ctrl+C in it with nothing selected copies the quote.
// ponytail: one length, 8000 characters (an agent reply rarely runs longer); a longer one is cut, with an ellipsis.
const MAX = 8000;
let shut = null;
export function quoteBox({ rect, text, add }) {
  shut?.();
  text = text.length > MAX ? text.slice(0, MAX) + '…' : text;
  const box = Object.assign(document.createElement('form'), { className: 'quote-box' });
  box.innerHTML = '<blockquote></blockquote><textarea rows="2" aria-label="Comment on the quote" placeholder="Comment (optional)"></textarea><div class="quote-bar"><button type="button">Cancel</button><button type="submit">Comment</button></div>';
  box.firstChild.textContent = text;
  const ta = box.querySelector('textarea'), ac = new AbortController();
  document.body.append(box);
  const h = box.offsetHeight, w = box.offsetWidth;
  box.style.left = Math.max(8, Math.min(rect.left, innerWidth - w - 8)) + 'px';
  box.style.top = (rect.bottom + 4 + h <= innerHeight - 8 ? rect.bottom + 4 : Math.max(8, rect.top - 4 - h)) + 'px';
  const close = shut = () => { ac.abort(); box.remove(); if (shut === close) shut = null; };
  box.onsubmit = e => { e.preventDefault(); close(); add({ text, comment: ta.value.trim() }); };
  box.querySelector('[type=button]').onclick = close;
  ta.onkeydown = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); box.requestSubmit(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && ta.selectionStart === ta.selectionEnd) navigator.clipboard?.writeText(text).catch(() => {});
  };
  document.addEventListener('pointerdown', e => { if (!box.contains(e.target)) close(); }, { capture: true, signal: ac.signal });
  ta.focus();
  return box;
}
