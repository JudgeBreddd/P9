// O128 (threat model row O128): the phone's own errors in the daemon's journal. The phone page and its service worker
// report uncaught errors, rejected promises and failed loads; each becomes one P9_PHONE_ERROR line on stderr (the user
// journal). The text is untrusted: cut to size, control characters made spaces, quoted text dropped (a JSON parse message
// quotes its input, which may be chat text), written as JSON so it stays one line. 10 lines a minute per device.
const MAX_BODY = 4096, PER_MINUTE = 10, KINDS = new Set(['error', 'rejection', 'load', 'sw']);
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, max);
const unquote = (text) => text.replace(/"[^"]*"|'[^']*'/g, '…');

export function createPhoneErrors(log = (line) => console.error(line), now = Date.now) {
  const minutes = new Map();  // device -> { start, count }
  return function report(device, raw) {
    if (Buffer.byteLength(raw) > MAX_BODY) return { status: 413, body: { error: 'body-too-large' } };
    let body;
    try { body = JSON.parse(raw); } catch {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: { error: 'request-refused' } };
    const t = now(), seen = minutes.get(device);
    const slot = seen && t - seen.start < 60000 ? seen : { start: t, count: 0 };
    minutes.set(device, slot);
    if (++slot.count > PER_MINUTE) {
      if (slot.count === PER_MINUTE + 1) log('P9_PHONE_ERRORS_DROPPED ' + JSON.stringify({ device, until: new Date(slot.start + 60000).toISOString() }));
      return { status: 429, body: { error: 'too-many' } };
    }
    const stack = String(body.stack ?? '').split('\n').map((line) => clean(unquote(line), 200).trim()).filter(Boolean).slice(0, 5);
    log('P9_PHONE_ERROR ' + JSON.stringify({ device, kind: KINDS.has(body.kind) ? body.kind : 'error', page: clean(body.page, 100),
      app: clean(body.app, 80), sw: clean(body.sw, 80), message: clean(unquote(String(body.message ?? '')), 300), stack }));
    return { status: 204 };
  };
}
