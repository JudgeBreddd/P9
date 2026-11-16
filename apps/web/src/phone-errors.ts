// O128 (threat model row O128): the phone's uncaught errors, rejected promises, failed script and style loads and its
// service worker's failures go to the daemon's journal (POST /phone-error, one line each). Imported first by phone.ts, so
// it listens before the rest of the app runs. Reports wait in this phone's storage (at most 20) while it is offline or
// signed out, and go when it is back online or on the next open. Only the page, build names, the message and stack lines
// are sent, never chat or typed text; the daemon cuts and cleans them. ponytail: a report made while signed out waits
// for the next signed-in open; the login page itself reports nothing.
type Report = { kind: string; message: string; stack: string; page: string; app: string; sw: string };
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
export function reportError(kind: string, error: unknown, fallback = '') {
  const e = error as { message?: unknown; stack?: unknown } | null;
  const message = String((e && typeof e === 'object' ? e.message : error) ?? fallback) || fallback;
  keep([...queued(), { kind, message: message.slice(0, 500), stack: String(e?.stack ?? '').slice(0, 2000), page: location.pathname, app, sw: sw() }]);
  void flush();
}
addEventListener('error', (event) => {
  const target = event.target as HTMLElement | null;
  // A script or style that failed to load: its error does not bubble, so this listens in the capture phase.
  if (target && target !== (window as unknown) && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
    const url = (target as HTMLScriptElement).src || (target as HTMLLinkElement).href || '';
    let path = url; try { path = new URL(url).pathname; } catch {}
    return reportError('load', null, 'failed to load ' + path);
  }
  if (event instanceof ErrorEvent) reportError('error', event.error ?? event.message, event.message);
}, true);
addEventListener('unhandledrejection', (event) => reportError('rejection', event.reason, 'rejected'));
addEventListener('online', () => void flush());
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => { const e = event.data?.p9SwError; if (e) reportError('sw', e, 'service worker error'); });
  navigator.serviceWorker.startMessages();
}
void flush();
