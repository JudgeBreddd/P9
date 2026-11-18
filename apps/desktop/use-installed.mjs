// O135 part B: whether the window offers to move a service that runs another copy onto the installed daemon (teh.mjs
// useInstalledDaemon, which needs the user's OK). Pure: no file, no systemd (main.mjs reads and writes keep-my-setup.json),
// so the rule is tested on its own.
// result: appImageService's answer ({ checkout, seen } when the service runs another copy); from: /health from (where the
// daemon runs from; a daemon older than #261, or none answering, has none); keep: the checkout the user chose to keep
// (keep-my-setup.json), or null; unit: whether p9-foundation.service exists; installed: the folder installed daemons live in.
// Returns 'ask', 'leave' (the user said keep for this same checkout) or 'nothing'.
import path from 'node:path';

export function daemonOffer({ result, from, keep, unit, installed }) {
  const checkout = result?.checkout;
  if (!unit || typeof checkout !== 'string' || !checkout || typeof result.seen !== 'string' || !result.seen) return 'nothing';
  if (keep === checkout) return 'leave';
  if (typeof from === 'string' && typeof installed === 'string' && (from + path.sep).startsWith(installed + path.sep)) return 'nothing';
  return 'ask';
}

// "Keep my setup" (keep-my-setup.json): the checkout the user said no for, so it is not asked about again; another checkout
// is. keptCheckout reads the file's text (null for none, broken or not a string); keepText is what is written.
export function keptCheckout(text) {
  try { const { checkout } = JSON.parse(text); return typeof checkout === 'string' ? checkout : null; } catch { return null; }
}
export const keepText = (checkout) => JSON.stringify({ checkout }) + '\n';
