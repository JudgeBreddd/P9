// Remote logins (phase 10): per-device passkeys. A device can enroll only after the desktop approves it over the Unix
// socket; the TCP port alone can never add a device. Lock means the device needs a fresh passkey; revoke is final.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse,
  verifyRegistrationResponse } from '@simplewebauthn/server';

const APPROVAL_MS = 10 * 60 * 1000;
const CHALLENGE_MS = 2 * 60 * 1000;
// P2 (v0.1.6): a session lasts 12 h from its last use, never more than 7 days from its login; a device (one passkey) keeps up to
// MAX_SESSIONS of them, one per browser it signs in from, so a login in one browser no longer ends the others.
export const SESSION_MS = 12 * 3600 * 1000, SESSION_MAX_MS = 7 * 24 * 3600 * 1000;
const MAX_SESSIONS = 4;
const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_PENDING = 3;
const MAX_CHALLENGES = 256;
const hash = (token) => createHash('sha256').update(token).digest('hex');
const NAME = /^[\p{L}\p{N} ._'-]{1,40}$/u;

// verify is replaceable so a test can hold a ceremony's await open and race a revoke or reset against it.
export function createAuth({ ledger, rpID, origin, now = Date.now,
  verify = { registration: verifyRegistrationResponse, authentication: verifyAuthenticationResponse } }) {
  const db = ledger.db;
  db.exec(`CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, credential TEXT UNIQUE NOT NULL,
      public_key BLOB NOT NULL, counter INTEGER NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, device TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, state TEXT NOT NULL,
      challenge TEXT, user TEXT NOT NULL, created INTEGER NOT NULL, approved INTEGER);
    CREATE TABLE IF NOT EXISTS audit (at INTEGER NOT NULL, event TEXT NOT NULL, device TEXT, detail TEXT);`);
  // P2: a session made before 0.1.6 has no login time; it counts from 12 h before its end.
  if (!db.prepare('PRAGMA table_info(sessions)').all().some((column) => column.name === 'created')) db.exec('ALTER TABLE sessions ADD COLUMN created INTEGER');
  const challenges = new Map();
  const failures = [];
  const noise = [];
  // Login ceremonies are ordered against desktop actions: a challenge issued before a device's last lock, revoke,
  // login or reset cannot log it in. Kept in memory: a daemon restart ends every ceremony anyway.
  let seq = 0, resetSeq = 0;
  const changed = new Map();
  const bump = (device) => changed.set(device, ++seq);
  const closers = new Set();

  function audit(event, device = null, detail = null) {
    db.prepare('INSERT INTO audit VALUES (?, ?, ?, ?)').run(now(), event, device, detail);
    console.error(JSON.stringify({ event: 'P9_AUTH', type: event, device }));
  }
  // ponytail: one global window, not per client: every remote request arrives from 127.0.0.1 through tailscale serve.
  function limited() {
    while (failures.length && failures[0] < now() - WINDOW_MS) failures.shift();
    return failures.length >= MAX_FAILURES;
  }
  function fail(event, device, detail) { failures.push(now()); audit(event, device, detail); }
  // Unauthenticated junk (unknown enrollment ids, enrollment floods) is audited at most MAX_FAILURES times a window,
  // so it cannot grow the table without bound or push real events out of the desktop's 50-row view.
  function quiet(event, detail) {
    while (noise.length && noise[0] < now() - WINDOW_MS) noise.shift();
    if (noise.length < MAX_FAILURES) { noise.push(now()); audit(event, null, detail); }
  }
  const close = (device) => { for (const closer of closers) closer(device); };
  function issue(device, unlock = false) {
    // A login or enrollment adds a session for this browser (P2): the device's other browsers stay signed in. Only the
    // oldest beyond MAX_SESSIONS goes. An unlock starts clean: no session from before the lock comes back with it.
    if (unlock) { db.prepare('DELETE FROM sessions WHERE device = ?').run(device); close(device); }
    db.prepare('DELETE FROM sessions WHERE device = ? AND expires < ?').run(device, now());
    db.prepare('DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE device = ? ORDER BY COALESCE(created, expires - ?) DESC, rowid DESC LIMIT -1 OFFSET ?)').run(device, SESSION_MS, MAX_SESSIONS - 1);
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (hash, device, csrf, expires, created) VALUES (?, ?, ?, ?, ?)').run(hash(token), device, csrf, now() + SESSION_MS, now());
    return { token, csrf };
  }
  // Review #11: the deadline counts from the approval once there is one, so a phone that waited 9 minutes for the
  // desktop still gets 10 to finish; an unapproved request still lapses 10 minutes after it was made.
  function expire() {
    db.prepare("UPDATE enrollments SET state = 'expired' WHERE state IN ('pending', 'approved', 'verifying') AND COALESCE(approved, created) < ?").run(now() - APPROVAL_MS);
  }

  return {
    onClose: (closer) => closers.add(closer),
    // Public, from the TCP port: ask to enroll. Nothing is granted until the desktop approves this id.
    request(body) {
      if (limited()) return { status: 429, error: 'rate-limited' };
      if (!body || typeof body.name !== 'string' || !NAME.test(body.name) || Object.keys(body).length !== 1) return { status: 400, error: 'request-refused' };
      expire();
      if (db.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE state = 'pending'").get().n >= MAX_PENDING) {
        quiet('enroll-flood');
        return { status: 429, error: 'too-many-pending' };
      }
      const id = randomUUID(), code = String(randomInt(0, 1e6)).padStart(6, '0');
      db.prepare("INSERT INTO enrollments VALUES (?, ?, ?, 'pending', NULL, ?, ?, NULL)").run(id, body.name, code, randomUUID(), now());
      audit('enroll-requested', null, id);
      return { status: 201, enrollment: id, code };
    },
    // Desktop only (Unix socket).
    approve(id) {
      expire();
      const changed = db.prepare("UPDATE enrollments SET state = 'approved', approved = ? WHERE id = ? AND state = 'pending'").run(now(), id).changes;
      if (!changed) return { status: 404, error: 'unknown-enrollment' };
      audit('enroll-approved', null, id);
      return { status: 200, result: 'approved' };
    },
    refuse(id) {
      const changed = db.prepare("UPDATE enrollments SET state = 'refused' WHERE id = ? AND state IN ('pending', 'approved', 'verifying')").run(id).changes;
      if (changed) audit('enroll-refused', null, id);
      return changed ? { status: 200, result: 'refused' } : { status: 404, error: 'unknown-enrollment' };
    },
    async enrollOptions(id) {
      if (limited()) return { status: 429, error: 'rate-limited' };
      expire();
      const row = db.prepare("SELECT * FROM enrollments WHERE id = ? AND state = 'approved' AND challenge IS NULL").get(String(id));
      if (!row) return { status: 403, error: 'approval-required' };
      const options = await generateRegistrationOptions({ rpName: 'P9', rpID, userName: row.name,
        userID: Buffer.from(row.user), attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
      // Two concurrent calls both saw no challenge; only the first write wins, so the second gets no usable options.
      if (!db.prepare("UPDATE enrollments SET challenge = ? WHERE id = ? AND state = 'approved' AND challenge IS NULL").run(options.challenge, id).changes) return { status: 403, error: 'approval-required' };
      return { status: 200, options };
    },
    async enrollVerify(id, response) {
      if (limited()) return { status: 429, error: 'rate-limited' };
      expire();
      const row = db.prepare("SELECT * FROM enrollments WHERE id = ? AND state = 'approved' AND challenge IS NOT NULL").get(String(id));
      if (!row) { quiet('enroll-refused-unapproved', String(id).slice(0, 64)); return { status: 403, error: 'approval-required' }; }
      // One attempt per approval: a failed or replayed registration burns it, and a new one needs the desktop again.
      // 'verifying' while the check awaits, so a desktop refuse or reset meanwhile cancels it.
      db.prepare("UPDATE enrollments SET state = 'verifying' WHERE id = ?").run(id);
      const finish = () => db.prepare("UPDATE enrollments SET state = 'used' WHERE id = ? AND state = 'verifying' AND COALESCE(approved, created) >= ?").run(id, now() - APPROVAL_MS).changes;
      let verified;
      try {
        verified = await verify.registration({ response, expectedChallenge: row.challenge, expectedOrigin: origin,
          expectedRPID: rpID, requireUserVerification: true });
      } catch { verified = null; }
      if (!finish()) { audit('enroll-cancelled', null, id); return { status: 403, error: 'approval-required' }; }
      if (!verified?.verified) { audit('enroll-failed', null, id); return { status: 400, error: 'registration-refused' }; }
      const { credential } = verified.registrationInfo;
      if (db.prepare('SELECT id FROM devices WHERE credential = ?').get(credential.id)) { audit('enroll-duplicate', null, id); return { status: 409, error: 'credential-exists' }; }
      const device = randomUUID();
      db.prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?, 'active', ?)").run(device, row.name, credential.id,
        Buffer.from(credential.publicKey), credential.counter, now());
      audit('enrolled', device);
      return { status: 201, device, ...issue(device) };
    },
    async loginOptions() {
      if (limited()) return { status: 429, error: 'rate-limited' };
      const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
      for (const [challenge, entry] of challenges) if (entry.expires < now()) challenges.delete(challenge);
      if (challenges.size >= MAX_CHALLENGES) { quiet('challenge-cap'); return { status: 429, error: 'rate-limited' }; }
      challenges.set(options.challenge, { expires: now() + CHALLENGE_MS, issued: seq });
      return { status: 200, options };
    },
    async loginVerify(response) {
      if (limited()) return { status: 429, error: 'rate-limited' };
      const device = db.prepare("SELECT * FROM devices WHERE credential = ? AND state != 'revoked'").get(String(response?.id ?? ''));
      let verified, issued;
      try {
        verified = device && await verify.authentication({ response, expectedOrigin: origin, expectedRPID: rpID,
          requireUserVerification: true,
          // Single use: the challenge is spent the moment it is checked, pass or fail, so a concurrent replay finds it gone.
          expectedChallenge: (challenge) => { const entry = challenges.get(challenge); challenges.delete(challenge); issued = entry?.issued; return (entry?.expires ?? 0) >= now(); },
          credential: { id: device.credential, publicKey: new Uint8Array(device.public_key), counter: device.counter } });
      } catch { verified = null; }
      if (!verified?.verified) { fail('login-failed', device?.id ?? null); return { status: 401, error: 'login-refused' }; }
      // A lock, revoke, login or reset after the challenge was issued wins, and so does any change during the await.
      const stale = issued === undefined || (changed.get(device.id) ?? 0) > issued || resetSeq > issued;
      if (stale || !db.prepare("UPDATE devices SET counter = ?, state = 'active' WHERE id = ? AND state = ?").run(verified.authenticationInfo.newCounter, device.id, device.state).changes) {
        audit('login-cancelled', device.id);
        return { status: 401, error: 'login-refused' };
      }
      bump(device.id);
      audit(device.state === 'locked' ? 'unlocked' : 'login', device.id);
      return { status: 200, device: device.id, ...issue(device.id, device.state === 'locked') };
    },
    // Every remote request: 0 with the session, or 401 / 423.
    session(token) {
      if (typeof token !== 'string' || !token) return { status: 401 };
      const row = db.prepare('SELECT s.device, s.csrf, s.expires, s.created, d.state FROM sessions s JOIN devices d ON d.id = s.device WHERE s.hash = ?').get(hash(token));
      if (!row || row.expires < now() || row.state === 'revoked') return { status: 401 };
      if (row.state === 'locked') return { status: 423, device: row.device };
      // Sliding (P2): use in the second half of the 12 h moves the end to 12 h from now, capped at 7 days from the login.
      const end = Math.min(now() + SESSION_MS, (row.created ?? row.expires - SESSION_MS) + SESSION_MAX_MS);
      if (end - row.expires > SESSION_MS / 2) {
        db.prepare('UPDATE sessions SET expires = ? WHERE hash = ?').run(end, hash(token));
        return { status: 0, device: row.device, csrf: row.csrf, expires: end, renewed: true };
      }
      return { status: 0, device: row.device, csrf: row.csrf, expires: row.expires };
    },
    lock(device, by) {
      const changed = db.prepare("UPDATE devices SET state = 'locked' WHERE id = ? AND state = 'active'").run(device).changes;
      if (changed) { bump(device); audit('locked', device, by); close(device); }
      return changed ? { status: 200, result: 'locked' } : { status: 404, error: 'unknown-device' };
    },
    revoke(device) {
      const changed = db.prepare("UPDATE devices SET state = 'revoked' WHERE id = ? AND state != 'revoked'").run(device).changes;
      if (!changed) return { status: 404, error: 'unknown-device' };
      bump(device);
      db.prepare('DELETE FROM sessions WHERE device = ?').run(device);
      audit('revoked', device);
      close(device);
      return { status: 200, result: 'revoked' };
    },
    // Reset: every device revoked and every open enrollment dropped; the next device needs the desktop again.
    reset() {
      const devices = db.prepare("SELECT id FROM devices WHERE state != 'revoked'").all().map((row) => row.id);
      db.prepare("UPDATE devices SET state = 'revoked'").run();
      resetSeq = ++seq;
      db.prepare('DELETE FROM sessions').run();
      db.prepare("UPDATE enrollments SET state = 'refused' WHERE state IN ('pending', 'approved', 'verifying')").run();
      audit('reset', null, String(devices.length));
      for (const device of devices) close(device);
      return { status: 200, result: 'reset', revoked: devices.length };
    },
    list() {
      expire();
      db.prepare('DELETE FROM sessions WHERE expires < ?').run(now());
      return {
        devices: db.prepare('SELECT id, name, state, created FROM devices ORDER BY created').all(),
        enrollments: db.prepare("SELECT id, name, code, state, created FROM enrollments WHERE state IN ('pending', 'approved') ORDER BY created").all(),
        audit: db.prepare('SELECT at, event, device, detail FROM audit ORDER BY rowid DESC LIMIT 50').all(),
      };
    },
  };
}
