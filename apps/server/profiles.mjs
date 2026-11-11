// Provider profiles (0.1.9 O48, SECURITY.md "Provider profiles"): another service that speaks Claude's API, for Claude
// chats. One file, <ownership>/profiles.json, beside the ledger: owner-only folder, mode 600, written by create-then-rename.
// The key (or the command that prints it) never leaves this module except through secret(), which chat.mjs calls at a
// chat's start and passes to that one agent over its stdin. list() is everything the page may see.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { childEnv } from './child-env.mjs';

const PRINT = /^[^\p{Cc}\p{Cf}]+$/u; // no control or format characters
export const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/; // a model name goes into the agent's environment
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && PRINT.test(v);
const baseUrl = (v) => {
  if (!text(v, 300) || /\s/.test(v)) return null;
  let url; try { url = new URL(v); } catch { return null; }
  // No sign-in, query or fragment inside the URL: the key has its own field.
  return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? v.replace(/\/+$/, '') : null;
};

export function createProfiles(directory) {
  const file = directory && path.join(directory, 'profiles.json');
  let all = [];
  try { const read = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(read)) all = read.filter((p) => typeof p?.id === 'string'); } catch {}
  const write = () => { if (!file) return; writeFileSync(file + '.tmp', JSON.stringify(all, null, 1) + '\n', { mode: 0o600 }); renameSync(file + '.tmp', file); };
  const shown = (p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models, secret: p.key ? 'key' : p.command ? 'command' : 'none' });
  return {
    list: () => all.map(shown),
    get: (id) => { const p = all.find((x) => x.id === id); return p ? shown(p) : null; },
    // body: { id?, name, baseUrl, models: [..], key?, command? }. With an id, a missing key and command keep the saved
    // ones; key: '' or command: '' removes it. Setting one clears the other. Returns the shown profile, or null (refused).
    save(body) {
      const old = body?.id === undefined ? null : all.find((x) => x.id === body.id);
      if (body?.id !== undefined && !old) return null;
      const url = baseUrl(body?.baseUrl), models = Array.isArray(body?.models) ? [...new Set(body.models)] : [];
      if (!text(body?.name, 40) || !url || models.length < 1 || models.length > 20 || !models.every((m) => typeof m === 'string' && MODEL.test(m))) return null;
      for (const k of ['key', 'command']) if (body[k] !== undefined && body[k] !== '' && (!text(body[k], 500) || (k === 'key' && /\s/.test(body[k])))) return null;
      const next = { id: old?.id ?? randomUUID(), name: body.name.trim(), baseUrl: url, models, key: old?.key ?? '', command: old?.command ?? '' };
      if (body.key !== undefined) { next.key = body.key; if (body.key) next.command = ''; }
      if (body.command !== undefined) { next.command = body.command.trim(); if (next.command) next.key = ''; }
      all = old ? all.map((x) => (x === old ? next : x)) : [...all, next];
      if (all.length > 20) { all = all.filter((x) => x !== next); return null; }
      write();
      return shown(next);
    },
    remove(id) { const before = all.length; all = all.filter((x) => x.id !== id); if (all.length === before) return false; write(); return true; },
    // The key for one chat start: the saved one, or the first line the command prints (no shell, the allow-list
    // environment, 10 s). Rejects with a message that never holds the key or the command's output.
    secret(id) {
      const p = all.find((x) => x.id === id);
      if (!p) return Promise.reject(new Error('profile-gone'));
      if (p.key) return Promise.resolve(p.key);
      if (!p.command) return Promise.reject(new Error('profile-no-key'));
      const argv = p.command.split(/\s+/); // ponytail: split on spaces, no quoting; a path with a space needs a wrapper script
      return new Promise((resolve, reject) => execFile(argv[0], argv.slice(1), { env: childEnv(), timeout: 10000, maxBuffer: 65536, shell: false, windowsHide: true }, (error, stdout) => {
        const key = error ? '' : String(stdout).split(/\r?\n/)[0].trim();
        key && key.length <= 500 && !/\s/.test(key) ? resolve(key) : reject(new Error('profile-command-failed'));
      }));
    },
  };
}
