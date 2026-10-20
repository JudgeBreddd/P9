// A remote request runs inside a store holding its session check (phase 10). Code about to start a side effect after
// an await calls stillAuthorized(): if the device was revoked, locked or logged out meanwhile, the work stops there.
// Desktop (Unix socket) requests have no store and always pass.
import { AsyncLocalStorage } from 'node:async_hooks';

export const authority = new AsyncLocalStorage();

export function stillAuthorized() {
  if (authority.getStore()?.() === false) throw new Error('session-ended');
}

// For work that runs later, outside the request (a timer, a child's exit): capture now, ask then. Never throws.
export function captureAuthority() {
  const check = authority.getStore();
  return () => check?.() !== false;
}
