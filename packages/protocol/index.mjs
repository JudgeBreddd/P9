export const ORIGIN = 'http://p9.local';
export const MAX_BYTES = 2 * 1024 * 1024;
// Remote listener only (phase 10): the login page and passkey ceremonies. Everything else needs a device session.
export const PUBLIC_ROUTES = Object.freeze(['/login', '/login.js', '/auth']);
export const ROUTES = Object.freeze(['/health', '/files', '/mission', '/scripts', '/runs', '/apps', '/pages', '/terminals', '/chat', '/usage', '/anymouse', '/phone', '/_astro', '/manifest.webmanifest', '/sw.js', '/duwop-boot.js', '/rebuild', '/p9-icon.svg', '/stop-all', '/frame']);
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
