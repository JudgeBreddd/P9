// Pinned cards (threat model row 42): text the agent of a P9 chat pins above that chat's composer with the P9 MCP
// server's pin_card. A card is a chat event ('card' { id, kind, text }; 'unpin' { id }), so the ledger keeps it and the
// desktop and the phone replay it in order: the last card with an ID is the one shown, until an unpin. They render the
// text with md() (helpers.mjs), which shows HTML as text. Pinning writes no file, so the agent lock does not stop it.
// ponytail: no cap on how many cards a chat holds (each is at most 8 KB, like any reply); the strip scrolls.
export const KINDS = ['markdown', 'checklist', 'table'];
export const MAX_TEXT = 8192; // bytes of UTF-8
export const CARD_ID = /^[A-Za-z0-9._-]{1,64}$/;

// The card event's data, or the refusal the agent reads.
export function card({ id, kind, text }) {
  if (typeof id !== 'string' || !CARD_ID.test(id)) return { error: 'request-refused', detail: 'id: 1 to 64 of A-Z a-z 0-9 . _ -' };
  if (!KINDS.includes(kind)) return { error: 'request-refused', detail: 'kind: ' + KINDS.join(', ') };
  if (typeof text !== 'string' || !text.trim()) return { error: 'request-refused', detail: 'text: Markdown, not empty' };
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT) return { error: 'too-large', detail: 'text: at most ' + MAX_TEXT + ' bytes of UTF-8' };
  return { id, kind, text };
}
