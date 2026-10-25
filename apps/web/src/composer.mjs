// Sending while a turn runs (CP1; the 2026-10-24 decision: a chip with Steer / Queue / Cancel, as in the agents' own
// terminals). Steer (Enter) goes into the turn when its current tool call ends; Queue (Tab) goes after the turn; Cancel
// (Esc) ends the turn and the text stays in the box. The daemon holds both (chat.mjs hold), so they survive a window
// restart; the window lists what it holds, each with an x that takes it back into the box.
import { esc, svg } from './helpers.mjs';

const button = (attr, label, key, title) => `<button data-slot="button" data-variant="ghost" data-size="sm" ${attr} title="${title}">${label} <kbd>${key}</kbd></button>`;
export const chip = () => `<span class="hint" role="group" aria-label="Send while the agent works">`
  + button('data-when="steer"', 'Steer', 'Enter', 'Send into this turn when its current step ends. Ctrl Enter interrupts and sends now')
  + button('data-when="queue"', 'Queue', 'Tab', 'Send when this turn ends')
  + button('data-cancel', 'Cancel', 'Esc', 'Stop this turn; your text stays in the box') + '</span>';

// The messages the daemon holds for this turn, above the local queue (which is only for an agent without steering).
export const waiting = s => (s.held || []).map(h => `<div class="q" data-held="${esc(h.id)}"><span>${h.when === 'queue' ? 'Queued' : 'After this step'}: ${esc(h.text)}</span><button title="Take it back into the box" data-unhold="${esc(h.id)}">${svg.x}</button></div>`).join('');

// What a key in the box does while a turn runs: 'steer', 'queue', 'cancel', or null (the box keeps the key).
export const turnKey = e => e.shiftKey || e.altKey || e.ctrlKey || e.metaKey ? null : { Enter: 'steer', Tab: 'queue', Escape: 'cancel' }[e.key] ?? null;

// CP4: a tool's edit as a line diff (longest common subsequence): unchanged lines show 3 either side of a change, and a
// run of them cut out shows as one "⋯" line. ponytail: an n*m table, so an edit past 1M line pairs shows as all removed
// then all added; Myers' diff if those come up.
export const lineDiff = (a, b) => {
  const n = a.length, m = b.length, out = [];
  if (n * m > 1e6) return [...a.map(l => ['del', l]), ...b.map(l => ['add', l])];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && a[i] === b[j]) { out.push(['ctx', a[i++]]); j++; }
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) out.push(['del', a[i++]]);
    else out.push(['add', b[j++]]);
  }
  const near = k => out.slice(Math.max(0, k - 3), k + 4).some(r => r[0] !== 'ctx');
  return out.flatMap((r, k) => r[0] !== 'ctx' || near(k) ? [r] : k > 0 && near(k - 1) ? [['ctx', '⋯']] : []);
};
