import { afterPress } from './press-hold.mjs';
// A2 step 6: quote a reply, or the part of it selected, with a comment. Loads on first use (chat-view.mjs quote, the
// phone's too). The box opens just under the selection, or above it when the window has no room below, inside host (the
// chat's dialog when the chat is in one, so it is not behind it). Enter adds the quote, with what was typed as its comment,
// to the message box as a chip; Esc or Cancel closes it and back() gets the focus; a click outside, the focus leaving it or
// the chat going out of sight closes it too, keeping a typed comment as the chip (leave).
// The box takes the focus, and with it the page's selection: Ctrl+C in it with nothing selected copies the selection as it
// was (raw: untrimmed, uncut). alive() says the chat it was asked from is still the one shown and on top; Comment checks it,
// and while the box is open it is checked every 200 ms: another chat in its pane, another focus mode, a dialog over it or a
// dialog's contents changed closes the box, whatever caused it.
// ponytail: a 200 ms check rather than an event from every place that changes what is shown (they were missed: review round 3).
// ponytail: one length, 8000 characters (an agent reply rarely runs longer); a longer quote is cut, with an ellipsis.
// Step 6 follow-up (owner, 2026-11-25): a selection no longer opens the box by itself (it took the selection, so Copy did not
// work). commentButton() puts a small Comment button beside it; the button opens the box. The pencil on a quote's chip opens
// the box again with its comment (comment: the text it starts with).
const MAX = 8000;
let shut = null, n = 0, pop = null;
const owed = new Set();
// Comments kept by presses outside wait for each press's click (afterPress); settle adds them at once, so a box opened
// meanwhile for the same chip (its pencil tapped again) starts from it, not from the comment before it.
export const settle = () => [...owed].forEach((f) => f());
// range: a copy of the selection it is for (cloneRange, taken when it was made), raw its text. A selection changed or
// cleared since (Shift+arrow, the same words in another reply, or while this file loaded) gets no button, and closes it.
// at(): where that text is now (the chat may scroll under it while a reply streams); the button follows it. view: the
// scrolling history; the button goes once the text scrolls out of it.
export function commentButton({ range, raw, view, host = document.body, pick, alive = () => true }) {
  pop?.();
  const at = () => range.getBoundingClientRect();
  const same = () => { const s = getSelection(), r = s.rangeCount && s.getRangeAt(0);
    return !!r && s.toString() === raw && r.startContainer === range.startContainer && r.startOffset === range.startOffset && r.endContainer === range.endContainer && r.endOffset === range.endOffset; };
  if (!same()) return;
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'comment-pop', textContent: 'Comment' });
  b.title = 'Comment on the selected text';
  const ac = new AbortController(), close = pop = () => { ac.abort(); b.remove(); if (pop === close) pop = null; };
  host.append(b);
  const place = () => { const rect = at(), v = view?.getBoundingClientRect();
    if ((!rect.width && !rect.height) || (v && (rect.bottom < v.top || rect.top > v.bottom))) return close(); // redrawn away, or scrolled out
    b.style.left = Math.max(8, Math.min(rect.right - b.offsetWidth, innerWidth - b.offsetWidth - 8)) + 'px';
    b.style.top = (rect.bottom + 4 + b.offsetHeight <= innerHeight - 8 ? rect.bottom + 4 : Math.max(8, rect.top - 4 - b.offsetHeight)) + 'px'; };
  b.onpointerdown = e => e.preventDefault(); // the selection stays while the button is pressed
  b.onclick = () => { close(); if (alive() && same()) pick(at()); };
  // Gone when the selection is or changes, on Esc, or a press elsewhere; moved with the text when the chat scrolls.
  document.addEventListener('selectionchange', () => same() || close(), { signal: ac.signal });
  document.addEventListener('scroll', place, { capture: true, passive: true, signal: ac.signal });
  document.addEventListener('keydown', e => e.key === 'Escape' && close(), { capture: true, signal: ac.signal });
  document.addEventListener('pointerdown', e => e.target !== b && close(), { capture: true, signal: ac.signal });
  const watch = setInterval(() => alive() || close(), 200); ac.signal.addEventListener('abort', () => clearInterval(watch));
  place(); // after the cleanup is in place: a first place() that closes stops the timer too
  return b;
}
// edit: the box is a chip's pencil; leaving it saves any change to the comment, a cleared one too.
export function quoteBox({ rect, text: whole, raw = whole, comment = '', edit = false, add, host = document.body, back, alive = () => true }) {
  pop?.();
  shut?.();
  const text = whole.length > MAX ? whole.slice(0, MAX) + '…' : whole, id = 'quote-' + ++n;
  const box = Object.assign(document.createElement('form'), { className: 'quote-box' });
  box.setAttribute('aria-label', 'Comment on a quote');
  box.innerHTML = `<blockquote id="${id}"></blockquote><textarea rows="2" aria-label="Comment" aria-describedby="${id}" placeholder="Comment (optional)"></textarea><div class="quote-bar"><button type="button">Cancel</button><button type="submit">Comment</button></div>`;
  box.firstChild.textContent = text;
  const ta = box.querySelector('textarea'), ac = new AbortController();
  ta.value = comment;
  host.append(box);
  // Against the visible part of the page: a phone's keyboard shrinks it, so the box moves up with it (review: Comment and
  // Cancel could end below the keyboard).
  // It is fitted to that part in both directions and scrolls inside when it is taller (a keyboard open in landscape) or
  // wider (pinch zoom).
  const place = () => { const v = window.visualViewport, left = v ? v.offsetLeft : 0, top = v ? v.offsetTop : 0, width = v ? v.width : innerWidth, height = v ? v.height : innerHeight;
    Object.assign(box.style, { maxWidth: width - 16 + 'px', maxHeight: height - 16 + 'px', overflow: 'auto' });
    const h = box.offsetHeight, w = box.offsetWidth, bottom = top + height;
    box.style.left = Math.max(left + 8, Math.min(rect.left, left + width - w - 8)) + 'px';
    box.style.top = Math.max(top + 8, Math.min(rect.bottom + 4 + h <= bottom - 8 ? rect.bottom + 4 : rect.top - 4 - h, bottom - 8 - h)) + 'px'; };
  place();
  const close = (refocus) => { ac.abort(); box.remove(); if (shut === leave) shut = null; if (refocus) back?.(); };
  window.visualViewport?.addEventListener('resize', place, { signal: ac.signal }); window.visualViewport?.addEventListener('scroll', place, { signal: ac.signal });
  // Leaving without Comment (another focus mode or chat, a click outside, another box): a comment typed is kept, as the chip
  // (the owner, 2026-11-25: keep it as the chip, to finish with the pencil). away: the reader went elsewhere, so the message box does not take the focus. Cancel and Esc drop it.
  // press: left by pressing outside (its pointerdown); the chip is added once that press's click has run (afterPress).
  const leave = shut = (press) => { const c = ta.value.trim(); close(); if (!(edit ? c !== comment.trim() : c)) return;
    const go = () => add({ text, comment: c }, true);
    if (!(press instanceof PointerEvent)) return go();
    const once = () => owed.delete(once) && go(); owed.add(once);
    afterPress(press, once); };
  box.onsubmit = e => { e.preventDefault(); close(); if (alive()) add({ text, comment: ta.value.trim() }); };
  box.querySelector('[type=button]').onclick = () => close(true);
  box.onkeydown = e => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(true); } };
  ta.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); box.requestSubmit(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && ta.selectionStart === ta.selectionEnd) navigator.clipboard?.writeText(raw).catch(() => {});
  };
  // Tab or a shortcut taking the focus out (to another chat, say) closes it as a click outside does.
  box.addEventListener('focusout', e => { if (e.relatedTarget && !box.contains(e.relatedTarget)) leave(); }, { signal: ac.signal });
  const watch = setInterval(() => alive() || leave(), 200); ac.signal.addEventListener('abort', () => clearInterval(watch));
  document.addEventListener('pointerdown', e => { if (!box.contains(e.target)) leave(e); }, { capture: true, signal: ac.signal });
  ta.focus(); ta.setSelectionRange(comment.length, comment.length);
  return box;
}
