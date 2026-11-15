// The sprint's files (sprint spec D1, D3, D4; SECURITY.md § Sprint files). Plain files in the sprint's folder in P9's
// state, <ownership>/sprints/<lead chat id>/, beside the worker folders: the lead's agent, its workers and the owner
// (project page) all read and edit them. Only these names: sprint.md; rules.md (the sprint rules set_rules writes, sent
// with every lead message); roles.json (each role's key, provider, model and effort: what Start sprint makes);
// roles/<key>.instructions.md (sent once, at the worker's start); roles/<key>.rules.md (sent with the sprint rules to
// that worker); roles/<key>.work.md (the role's work: its first message at Start sprint); notes/<key>.md (the worker
// keeps it itself: Now and Log).
import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = '[a-z0-9][a-z0-9._-]{0,63}'; // open_chat's key rule
const NAME = new RegExp(`^(?:sprint\\.md|rules\\.md|roles\\.json|roles/${KEY}\\.(?:instructions|rules|work)\\.md|notes/${KEY}\\.md)$`);
export const MAX_FILE = 32000; // as project instructions
const PLAN = '# Plan\n\nGoal:\n\n## Items\n<!-- one per line: - [ ] <item>: done means ...; checks ...; role ...; depends on ... -->\n\n## What I will need from you\n<!-- every action only the owner can take, listed before work starts -->\n';
// What the project page opened: a save names it, and a file changed since (a worker, the lead) is not replaced.
export const hashOf = (text) => createHash('sha256').update(text).digest('hex');
// What a worker is told about its notes file, at its start and again after each compaction.
export const notesLine = (file) => `[P9: your notes file is ${file}. Keep its Now block current (doing, next, blocked on, not yet checked) and add one Log line for each decision, finding and result. After a compaction, read it first.]\n\n`;
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
  // Whole or not at all: a temp file beside it, put in place in one step. expect (the project page's save): the hash the
  // file must still have, '' for one that must not exist, else 'changed' and the other writer's text kept (O97). The
  // check and the swap are one guarded step: the file is renamed aside (a writer after that makes a new file), checked
  // there, and the new text placed without replacing anything (placeNew), which fails if a writer made the file
  // meanwhile. ponytail: a writer still holding the old file open is caught only up to the recheck after the placing;
  // for that instant the file is absent to readers.
  function write(lead, name, text, expect) {
    const file = fileOf(lead, name);
    if (!file || typeof text !== 'string' || text.length > MAX_FILE || !text.isWellFormed()) return false;
    if (expect !== undefined) { const now = read(lead, name); if (expect === '' ? now !== null : now === null || hashOf(now) !== expect) return 'changed'; }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.p9-tmp-' + randomUUID();
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    try {
      if (expect === undefined) { renameSync(temporary, file); return true; }
      return swap(file, temporary, expect) ? true : 'changed';
    } finally { try { unlinkSync(temporary); } catch { /* renamed or gone */ } }
  }
  // from put at to without ever replacing a file there: a hard link, or where a link fails (a disk without hard links) an
  // exclusive copy, which fails if to exists and removes its partial file on error. false: to exists (a writer got
  // there first); 'copy': placed by the copy.
  const placeNew = (from, to) => {
    try { linkSync(from, to); return true; } catch (error) { if (error.code === 'EEXIST') return false; }
    try { copyFileSync(from, to, constants.COPYFILE_EXCL); return 'copy'; } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  };
  const sameFile = (a, b) => { const x = statSync(a, { bigint: true }), y = statSync(b, { bigint: true }); return x.ino === y.ino && x.dev === y.dev; };
  // A file set aside back at its name, unless a newer file is there (then it goes). If it cannot be placed (a full disk),
  // it stays aside with its bytes and this throws with its path: nothing is deleted or replaced that was not put back.
  function restore(aside, file) {
    try { placeNew(aside, file); } catch (error) { throw Object.assign(new Error(`sprint file kept at ${aside}`), { cause: error, code: error.code }); }
    unlinkSync(aside);
  }
  // Ours out again, only if the file at the name is still ours: it is taken aside first (one step), compared there (the
  // same inode, or for a copy the same bytes), and a newer writer's file put back. true: ours removed; false: a newer
  // file is there.
  function takeBack(file, temporary, copied) {
    const grab = file + '.p9-back-' + randomUUID();
    try { renameSync(file, grab); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (copied ? readFileSync(grab).equals(readFileSync(temporary)) : sameFile(grab, temporary)) { unlinkSync(grab); return true; }
    restore(grab, file);
    return false;
  }
  function swap(file, temporary, expect) {
    if (expect === '') return !!placeNew(temporary, file);
    const aside = file + '.p9-old-' + randomUUID();
    try { renameSync(file, aside); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const kept = () => { try { return hashOf(readFileSync(aside, 'utf8')) === expect; } catch { return false; } };
    let mine = false, newer = false;
    try {
      const placed = kept() && placeNew(temporary, file);
      mine = !!placed;
      // Written through a handle opened before the rename: theirs wins, and ours goes only if it is still at the name.
      if (mine && !kept()) { mine = false; newer = !takeBack(file, temporary, placed === 'copy'); }
    } catch (error) {
      if (!mine) restore(aside, file); // else ours is in place and the aside copy is kept
      throw error;
    }
    if (mine || newer) unlinkSync(aside); else restore(aside, file);
    return mine;
  }
  // Made once, never over an edited file.
  const start = (lead, name, text) => { if (read(lead, name) === null && fileOf(lead, name)) write(lead, name, text); };
  return {
    folderOf,
    fileOf,
    read,
    write,
    // D1: the sprint's folder and its plan, made at the lead's first worker.
    ensure(lead) { start(lead, 'sprint.md', PLAN); return folderOf(lead); },
    // D3, D4: a worker's notes, under its key or its chat ID (a worker without a key); roles: a keyed worker's role files
    // too. Returns the notes file's full path.
    ensureWorker(lead, key, roles = true) {
      if (roles) { start(lead, `roles/${key}.instructions.md`, ''); start(lead, `roles/${key}.rules.md`, ''); }
      start(lead, `notes/${key}.md`, NOTES);
      return fileOf(lead, `notes/${key}.md`);
    },
    // A prep (Start sprint): the plan, the roles file and the lead's and reviewer's role files, before any chat exists.
    prep(lead, roles) {
      start(lead, 'sprint.md', PLAN);
      start(lead, 'roles.json', JSON.stringify(roles, null, 2) + '\n');
      for (const key of roles.roles.map((r) => r.key)) for (const kind of ['instructions', 'rules', 'work']) start(lead, `roles/${key}.${kind}.md`, '');
      return folderOf(lead);
    },
    // Every file of a sprint with its text, in a fixed order: plan, rules, roles.json, then roles and notes by name.
    list(lead) {
      const folder = folderOf(lead);
      if (!folder) return [];
      const names = ['sprint.md', 'rules.md', 'roles.json'];
      for (const dir of ['roles', 'notes']) {
        try { for (const f of readdirSync(path.join(folder, dir)).sort()) names.push(dir + '/' + f); } catch { /* none */ }
      }
      return names.map((name) => ({ name, text: read(lead, name) })).filter((f) => f.text !== null).map((f) => ({ ...f, hash: hashOf(f.text) }));
    },
    exists: (lead) => { const folder = folderOf(lead); try { return !!folder && lstatSync(folder).isDirectory(); } catch { return false; } },
  };
}
