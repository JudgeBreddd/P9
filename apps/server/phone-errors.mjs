// O128 (threat model row O128): the phone's own errors in the daemon's journal. The phone page and its service worker
// report uncaught errors, rejected promises and failed loads; each becomes one P9_PHONE_ERROR line on stderr (the user
// journal). Only structure is written, never text: the error's type name, the page, build names, a failed file's path
// and up to 5 stack frames as path:line:column. Each field must match its pattern or is dropped, so no message, chat or
// typed text can reach the journal whatever the phone sends. 10 lines a minute per device.
const MAX_BODY = 4096, PER_MINUTE = 10, KINDS = new Set(['error', 'rejection', 'load', 'sw']);
const NAME = /^[A-Za-z]{1,40}$/, PATH = /^\/[A-Za-z0-9_./-]{0,99}$/, FRAME = /^\/[A-Za-z0-9_./-]{0,99}:\d{1,7}:\d{1,7}$/, BUILD = /^[A-Za-z0-9_.-]{0,80}$/;
const only = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : '';

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
    const frames = (Array.isArray(body.frames) ? body.frames : []).map((frame) => only(frame, FRAME)).filter(Boolean).slice(0, 5);
    log('P9_PHONE_ERROR ' + JSON.stringify({ device, kind: KINDS.has(body.kind) ? body.kind : 'error', name: only(body.name, NAME) || 'other',
      page: only(body.page, PATH), file: only(body.file, PATH), app: only(body.app, BUILD), sw: only(body.sw, BUILD), frames }));
    return { status: 204 };
  };
}
