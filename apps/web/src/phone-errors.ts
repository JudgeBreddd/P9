// O128 (threat model row O128): the phone's uncaught errors, rejected promises, failed script and style loads and its
// service worker's failures go to the daemon's journal (POST /phone-error, one line each). Imported first by phone.ts, so
// it listens before the rest of the app runs. Reports wait in this phone's storage (at most 20) while it is offline or
// signed out, and go when it is back online or on the next open. A report is structure only, made here before it is
// stored or sent: the error's type name (or the thrown value's type), the page, build names, a failed file's path and
// up to 5 stack frames of this origin as path:line:column. Never the message: it can carry chat or typed text. The
// daemon checks every field again. ponytail: a report made while signed out waits for the next signed-in open; the
// login page itself reports nothing.
type Report = { kind: string; name: string; frames: string[]; file: string; page: string; app: string; sw: string };
const KEY = 'p9-phone-errors', MAX = 20;
const app = new URL(import.meta.url).pathname.split('/').pop() ?? '';
const sw = () => { try { return new URL(navigator.serviceWorker?.controller?.scriptURL ?? '').searchParams.get('v') ?? ''; } catch { return ''; } };
const queued = (): Report[] => { try { const all = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(all) ? all : []; } catch { return []; } };
const keep = (all: Report[]) => { try { if (all.length) localStorage.setItem(KEY, JSON.stringify(all.slice(-MAX))); else localStorage.removeItem(KEY); } catch {} };
const csrf = () => {
  const tab = sessionStorage.getItem('p9-csrf'); if (tab) return tab;
  try { return JSON.parse(localStorage.getItem('p9-csrf') ?? 'null')?.token ?? null; } catch { return null; }
};
let sending = false;
async function flush() {
  if (sending || !navigator.onLine) return;
  sending = true;
  try {
    for (let next = queued()[0]; next; next = queued()[0]) {
      const token = csrf(); if (!token) return;
      let status = 0;
      try { status = (await fetch('/phone-error', { method: 'POST', headers: { 'content-type': 'application/json', 'x-p9-csrf': token }, body: JSON.stringify(next) })).status; } catch {}
      // Kept for later: no network, or not signed in (401, 403). Anything else was answered and is done (204), or never will be (400, 413, 429).
      if (!status || status === 401 || status === 403) return;
      keep(queued().slice(1));
    }
  } finally { sending = false; }
}
const NAME = /^[A-Za-z]{1,40}$/, PATH = /^\/[A-Za-z0-9_./-]{0,99}$/;
// Frames only: a V8 line '    at fn (url:1:2)' or '    at url:1:2', or 'fn@url:1:2'. The V8 stack starts with
// 'Name: message', cut off first; a frame must be of this origin, and only its path and position are kept.
function frames(stack: string, name: string, message: string) {
  if (stack.startsWith(name + ': ' + message)) stack = stack.slice((name + ': ' + message).length);
  const out: string[] = [];
  for (const line of stack.split('\n')) {
    const m = /^\s*at (?:.* \()?(\S+):(\d+):(\d+)\)?$/.exec(line) ?? /^[^\s@]*@(\S+):(\d+):(\d+)$/.exec(line);
    if (!m) continue;
    try { const url = new URL(m[1]); if (url.origin === location.origin && PATH.test(url.pathname)) out.push(url.pathname + ':' + m[2] + ':' + m[3]); } catch {}
    if (out.length === 5) break;
  }
  return out;
}
export function reportError(kind: string, error: unknown, file = '') {
  const e = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown; stack?: unknown } : null;
  const name = e && typeof e.name === 'string' && NAME.test(e.name) ? e.name : e ? 'object' : typeof error;
  const stack = e && typeof e.stack === 'string' ? frames(e.stack, String(e.name ?? ''), String(e.message ?? '')) : [];
  keep([...queued(), { kind, name, frames: stack, file: PATH.test(file) ? file : '', page: PATH.test(location.pathname) ? location.pathname : '', app, sw: sw() }]);
  void flush();
}
addEventListener('error', (event) => {
  const target = event.target as HTMLElement | null;
  // A script or style that failed to load: its error does not bubble, so this listens in the capture phase.
  if (target && target !== (window as unknown) && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
    const url = (target as HTMLScriptElement).src || (target as HTMLLinkElement).href || '';
    let path = url; try { path = new URL(url).pathname; } catch {}
    return reportError('load', null, path);
  }
  if (event instanceof ErrorEvent) reportError('error', event.error);
}, true);
addEventListener('unhandledrejection', (event) => reportError('rejection', event.reason));
addEventListener('online', () => void flush());
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => { const e = event.data?.p9SwError; if (e) reportError('sw', e); });
  navigator.serviceWorker.startMessages();
}
void flush();
