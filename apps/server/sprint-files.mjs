// The sprint's files (sprint spec D1, D3, D4; SECURITY.md § Sprint files). Plain files in the sprint's folder in P9's
// state, <ownership>/sprints/<lead chat id>/, beside the worker folders: the lead's agent, its workers and the owner
// (project page) all read and edit them. Only these names: plan.md; rules.md (the sprint rules set_rules writes, sent
// with every lead message); roles/<key>.instructions.md (sent once, at the worker's start); roles/<key>.rules.md (sent
// with the sprint rules to that worker); notes/<key>.md (the worker keeps it itself: Now and Log).
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = '[a-z0-9][a-z0-9._-]{0,63}'; // open_chat's key rule
const NAME = new RegExp(`^(?:plan\\.md|rules\\.md|roles/${KEY}\\.(?:instructions|rules)\\.md|notes/${KEY}\\.md)$`);
export const MAX_FILE = 32000; // as project instructions
const PLAN = '# Plan\n\nGoal:\n\n## Items\n<!-- one per line: - [ ] <item>: done means ...; checks ...; role ...; depends on ... -->\n\n## What I will need from you\n<!-- every action only the owner can take, listed before work starts -->\n';
const NOTES = '## Now\nDoing:\nNext:\nBlocked on:\nNot yet checked:\n\n## Log\n';

export function createSprintFiles({ home }) {
  const folderOf = (lead) => (home && typeof lead === 'string' && ID.test(lead) ? path.join(home, lead) : null);
  // A name from the list above, and every folder on its way a real folder: a link put in place of one is refused.
  const fileOf = (lead, name) => {
    const folder = folderOf(lead);
    if (!folder || typeof name !== 'string' || !NAME.test(name) || name.split('/').some((p) => p.startsWith('.'))) return null;
    for (const dir of [home, folder, ...(name.includes('/') ? [path.join(folder, name.split('/')[0])] : [])]) {
      let info; try { info = lstatSync(dir); } catch { continue; } // not made yet: fine
      if (!info.isDirectory()) return null;
    }
    const file = path.join(folder, name);
    try { if (!lstatSync(file).isFile()) return null; } catch { /* not there yet */ }
    return file;
  };
  const read = (lead, name) => { const file = fileOf(lead, name); try { return file ? readFileSync(file, 'utf8') : null; } catch { return null; } };
  // Whole or not at all: a temp file beside it, renamed over the old one.
  function write(lead, name, text) {
    const file = fileOf(lead, name);
    if (!file || typeof text !== 'string' || text.length > MAX_FILE || !text.isWellFormed()) return false;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.p9-tmp-' + randomUUID();
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    try { renameSync(temporary, file); } catch (error) { try { unlinkSync(temporary); } catch { /* gone */ } throw error; }
    return true;
  }
  // Made once, never over an edited file.
  const start = (lead, name, text) => { if (read(lead, name) === null && fileOf(lead, name)) write(lead, name, text); };
  return {
    folderOf,
    fileOf,
    read,
    write,
    // D1: the sprint's folder and its plan, made at the lead's first worker.
    ensure(lead) { start(lead, 'plan.md', PLAN); return folderOf(lead); },
    // D3, D4: a keyed worker's role files and its notes. Returns the notes file's full path.
    ensureWorker(lead, key) {
      start(lead, `roles/${key}.instructions.md`, ''); start(lead, `roles/${key}.rules.md`, ''); start(lead, `notes/${key}.md`, NOTES);
      return fileOf(lead, `notes/${key}.md`);
    },
    // Every file of a sprint with its text, in a fixed order: plan, rules, then roles and notes by name.
    list(lead) {
      const folder = folderOf(lead);
      if (!folder) return [];
      const names = ['plan.md', 'rules.md'];
      for (const dir of ['roles', 'notes']) {
        try { for (const f of readdirSync(path.join(folder, dir)).sort()) names.push(dir + '/' + f); } catch { /* none */ }
      }
      return names.map((name) => ({ name, text: read(lead, name) })).filter((f) => f.text !== null);
    },
    exists: (lead) => { const folder = folderOf(lead); try { return !!folder && lstatSync(folder).isDirectory(); } catch { return false; } },
  };
}
