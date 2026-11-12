export const ORIGIN = 'http://p9.local';
export const MAX_BYTES = 2 * 1024 * 1024;
// Remote listener only (phase 10): the login page and passkey ceremonies. Everything else needs a device session.
export const PUBLIC_ROUTES = Object.freeze(['/login', '/login.js', '/auth']);
export const ROUTES = Object.freeze(['/health', '/files', '/mission', '/scripts', '/runs', '/apps', '/pages', '/terminals', '/chat', '/usage', '/anymouse', '/phone', '/_astro', '/manifest.webmanifest', '/sw.js', '/duwop-boot.js', '/rebuild', '/stop-all', '/agent-lock', '/file-protection', '/setup/settings', '/frame', '/projects']);
// Item 19 (threat model row 65): the artifact frame page's CSP, desktop (p9://frame/) and phone (/frame/) alike; each adds its
// frame-ancestors. The page is also framed with sandbox="allow-scripts": an opaque origin, no network, no forms, no top navigation.
export const FRAME_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

export function parseSave(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'content,hash,path'
      || typeof input.path !== 'string' || typeof input.content !== 'string'
      || typeof input.hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.hash)) {
    throw new Error('invalid-save');
  }
  return input;
}
// Threat model row 4: what turning File protection off risks, in the desktop's native warning (main.mjs) and the phone's
// confirm (phone.ts, c18).
export const FILE_PROTECTION_RISK = 'File protection stops P9\'s editor, here and on your paired phone, from opening or changing your secrets '
  + '(.env files and the secrets and _private folders), your git history (.git), P9\'s own recovery files (.p9-*) and the script list behind Mission buttons. Mission still shows the folders your Mission space names, notes folders outside the workspace (such as a notes vault) too, _private ones included.\n\n'
  + 'With it off, one wrong save can break those files, and anyone holding your unlocked, paired phone can read or change them, keys included.\n\n'
  + 'Agents, terminals and editor extensions are not affected: they can already change any file you can. You can turn protection back on any time in Settings.';

// Agent sign-in (threat model row 31): a sign-in URL leaves the daemon (phone) or main (desktop) only if its parsed origin is
// exactly that vendor's sign-in page (no prefix match: claude.com.evil.example and claude.com@evil.example fail), and Codex's
// one-time code only when it has exactly a code's shape.
export const SIGN_IN_ORIGINS = Object.freeze({ claude: ['https://claude.com', 'https://claude.ai', 'https://console.anthropic.com'], codex: ['https://auth.openai.com'] });
export const DEVICE_CODE = /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/;
export function signInUrl(agent, text) {
  try { const url = new URL(text); return Object.hasOwn(SIGN_IN_ORIGINS, agent) && SIGN_IN_ORIGINS[agent].includes(url.origin) ? url.href : null; } catch { return null; }
}
// A space section's parts (mission-fields.mjs SECTION.order), in the order the desktop draws them when the section names none.
export const PARTS = Object.freeze(['text', 'quick_note', 'notes', 'folders', 'refs', 'logs', 'buttons', 'data', 'cards', 'links', 'checklists', 'widgets']);
// The parts in a section's order: the ones order names that defaults has, once each, then the rest in the order defaults lists them.
export const partOrder = (order, defaults = PARTS) => {
  const named = Array.isArray(order) ? order.filter((part, index) => defaults.includes(part) && order.indexOf(part) === index) : [];
  return [...named, ...defaults.filter((part) => !named.includes(part))];
};
// A chat's last used time (History, the panel, the phone) is its newest event but these: the stops a close, an exit or a
// restart write, its created event, and the bookkeeping the user does to it (move to a project, rename, archive; Builder,
// nightly 3: "moving a chat to a project changes the edited last timer").
export const NOT_USE = Object.freeze(['created', 'stopped', 'closed', 'exited', 'interrupted', 'project', 'renamed', 'archived', 'askable']);
