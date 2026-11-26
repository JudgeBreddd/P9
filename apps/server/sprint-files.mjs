// The sprint's files (sprint spec D1, D3, D4; SECURITY.md § Sprint files). Plain files in the sprint's folder in P9's
// state, <ownership>/sprints/<lead chat id>/, beside the worker folders: the lead's agent, its workers and the owner
// (project page) all read and edit them. Only these names: sprint.md; rules.md (the sprint rules set_rules writes, sent
// with every lead message); roles.json (each role's key, provider, model and effort: what Start sprint makes);
// roles/<key>.instructions.md (sent once, at the worker's start); roles/<key>.rules.md (sent with the sprint rules to
// that worker); roles/<key>.work.md (the role's work: its first message at Start sprint); notes/<key>.md (the worker
// keeps it itself: Now and Log); review-trail.md (P9's own: one row per reviewed item, rewritten at each ready and
// verdict; nobody else writes it); hooks.json (the sprint's scripts: P9 runs only the copy the owner approved at Start,
// sprint-hooks.mjs); hooks.log (P9's own: one line per script run).
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = '[a-z0-9][a-z0-9._-]{0,63}'; // open_chat's key rule
const TRAIL = 'review-trail.md', LOG = 'hooks.log', LOG_LINES = 100;
const NAME = new RegExp(`^(?:sprint\\.md|rules\\.md|roles\\.json|review-trail\\.md|hooks\\.json|hooks\\.log|roles/${KEY}\\.(?:instructions|rules|work)\\.md|notes/${KEY}\\.md)$`);
export const MAX_FILE = 32000; // as project instructions
const TESTS = '; Tests: <file>::<title words> | <file>::<title words> (last clause; each title matches exactly one passed test in CI)';
// The Tests clause is the agreed tests the before-merge green check (scripts/green-check.mjs) holds an item to.
const PLAN = '# Plan\n\nGoal:\n\n## Items\n<!-- one per line: - [ ] <item>: done means ...; checks ...; role ...; depends on ...' + TESTS + ' -->\n\n## What I will need from you\n<!-- every action only the owner can take, listed before work starts -->\n';
const PLAN_0_1_8 = PLAN.replace(TESTS, ''); // the template before the Tests clause, written into older sprints
// What the project page opened: a save names it, and a file changed since (a worker, the lead) is not replaced.
export const hashOf = (text) => createHash('sha256').update(text).digest('hex');
// O171 (framing): the Setup files whose text P9 sends to chats. Start sprint keeps each one's hash in its record (the
// user's approval of that text); writerKey holds { by, hash } of the last write through P9 (the Setup page: the user;
// set_rules, open_chat rules, sprint_setup_save: the calling chat's agent). ponytail: a deleted sprint's records stay in prefs.
export const SENT = /^(?:rules\.md|roles\/[^/]+\.(?:rules|instructions)\.md)$/;
export const writerKey = (sprint, name) => `setup-writer:${sprint}:${name}`;
// H2 (the setup window): the files an agent can fill and the owner sees on Sprint Setup. Each keeps its writer (writerKey)
// and the hash the owner has seen (seenKey); one whose text the owner has not seen is marked "Written by ... · not seen".
export const MARKED = /^(?:sprint\.md|rules\.md|roles\.json|hooks\.json|roles\/[^/]+\.(?:rules|instructions|work)\.md)$/;
export const seenKey = (sprint, name) => `setup-seen:${sprint}:${name}`;
export const isPlan = (text) => text === PLAN || text === PLAN_0_1_8; // P9's own empty plan: nobody wrote it
// What a worker is told about its notes file, at its start and again after each compaction.
export const notesLine = (file) => `[P9: your notes file is ${file}. Keep its Now block current (doing, next, blocked on, not yet checked) and add one Log line for each decision, finding and result. After a compaction, read it first.]\n\n`;
// The work queue (sprint method rule 4: the item list is the chunks assigned to the worker): the
// plan's item lines whose role is this key, in order. The role is the word after "role" at the start of a clause
// ("; role daemon;" or ". Role: daemon."); an item's id is its text before the first colon. A tick in the plan is a
// model's say-so: P9 counts an item done from its own review record, never from the box. planItems: every item line
// with its role (or null) and its box, for a sprint script's input.
export function planItems(plan) {
  const items = [];
  for (const { line, phase } of walk(plan)) {
    if (line === undefined) continue;
    const found = /^\s*- \[([ xX])\] (.+)$/.exec(line), item = found?.[2].trim();
    if (!item) continue;
    const id = item.split(':')[0].trim().slice(0, 200);
    // O164 part (3): an id ending in v after its number (O159v) is the owner's own line, whatever role it names.
    const role = /\dv$/.test(id) ? 'owner' : [...item.matchAll(/(?:^|[;.]\s*)role:?\s+([a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*)/gi)].at(-1)?.[1].toLowerCase() ?? null;
    items.push({ id, text: item.slice(0, 500), role, ticked: found[1] !== ' ', phase });
  }
  return items;
}
// I1: the plan's phases. A "## Phase ..." heading (any level from ## down) opens one; it runs to the next phase heading,
// or to any other heading at its own level or above (the template's "## What I will need from you" after the last phase
// is in no phase). walk gives each line with its phase's index, null outside every phase; a phase heading comes as head.
function* walk(plan) {
  let n = -1, level = 0, open = false;
  for (const line of typeof plan === 'string' ? plan.split('\n') : []) {
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h && h[1].length >= 2 && /^phase\b/i.test(h[2])) { n += 1; level = h[1].length; open = true; yield { head: h[2].trim(), phase: n }; continue; }
    if (h && open && h[1].length <= level) open = false;
    yield { line, phase: open ? n : null };
  }
}
// Each phase's title and its section as written (its items, checks and evidence), for the plan view the I1 line opens.
// Capped in characters (code points, so no emoji is cut in half): PHASE_TEXT a phase, PLAN_TEXT over all of them, in
// order (a plan written past MAX_FILE straight to disk); truncated says the text was cut. A plan with no phase: [].
export const PHASE_TEXT = 4000, PLAN_TEXT = 32000;
export function phasesOf(plan) {
  const heads = [];
  for (const { head, line, phase } of walk(plan)) {
    if (head !== undefined) heads.push({ title: Array.from(head).slice(0, 200).join(''), lines: [] });
    else if (phase !== null) heads[phase].lines.push(line);
  }
  let left = PLAN_TEXT;
  return heads.map(({ title, lines }) => {
    const all = Array.from(lines.join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd()), keep = Math.min(PHASE_TEXT, left);
    left -= Math.min(all.length, keep);
    return { title, text: all.slice(0, keep).join(''), truncated: all.length > keep };
  });
}
// A Role: owner line is never a worker's queue, even a worker keyed 'owner' (O164 part (3)).
export const itemsOf = (plan, key) => planItems(plan).filter((i) => i.role && i.role !== 'owner' && i.role === key).map(({ id, text }) => ({ id, text }));
// O141: the lead's default instructions (Start sprint sends them once, as the owner's, like any Setup text): watching plan use is
// part of leading. The check rides in the scheduled prompt's own text, so it survives a compaction; the thresholds are this
// text, which the owner edits or deletes in Setup, not code. Close pauses the schedule (delegate.mjs closeSprint).
// Review 6: the cursor is read before the hold is sent (a held steer has none yet), so the reply cannot fall before it.
// Review 7: read_chat pages (more, next), so each watch reads on from where the last one stopped, not the first page again.
const LEAD = 'Watching plan use is part of leading this sprint: a window that hits its cap stops every worker, holding one stops only that one.\n'
  + '- At your first turn, call list_schedules. With no usage watch there, call schedule_prompt to yourself every 10 minutes with this text: '
  + '"Usage watch: call plan_usage. If a window your workers use has pace ahead and projected over 100 (its reading not stale), hold your '
  + 'least-advanced running worker not held yet: send it, as steer, Finish the step you are on, write a Next line in your notes, reply '
  + 'Holding for usage, end your turn, and wait until I resume you. A steer can wait in its queue until that turn ends, or be dropped with '
  + 'it, so it is held only once the worker replies Holding for usage after it: just before you send it, read_chat on the worker and '
  + 'keep that answer\'s next cursor with the held chat id, and on each watch read_chat from it (after) for the reply, following next while more is true, and keep the last next with the held chat id, so a busy worker\'s pages never hide it. Idle, working or a '
  + 'timeout is not yet: send the hold again to one idle without that reply, the same way (read_chat first, keep its next). When every window is back to on or headroom, resume every '
  + 'worker you held, not only the last. Keep each held chat id, with the numbers, under ## Usage watch in sprint.md: a line when you hold '
  + 'it, its confirmation, and its resume."\n'
  + '- A stale reading is no reason to hold: note it and wait for the next one.\n';
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
  // meanwhile. A writer still holding the old file open is caught up to the recheck after the placing: theirs is put
  // back and the save is a conflict. ponytail: one that writes after that recheck writes to a file with no name, the same
  // as after any whole-file write (temp and rename); no check can see a write after its last read without a lock every
  // writer takes, and agents take none (O101). For the instant of the swap the file is absent to readers. 'no-links': a
  // disk without hard links, where nothing can be placed whole without replacing (O100); the save is refused before
  // anything is moved.
  function put(lead, name, text, expect) {
    const file = fileOf(lead, name);
    if (!file || typeof text !== 'string' || text.length > MAX_FILE || !text.isWellFormed()) return false;
    if (expect !== undefined) { const now = read(lead, name); if (expect === '' ? now !== null : now === null || hashOf(now) !== expect) return 'changed'; }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.p9-tmp-' + randomUUID();
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    try {
      if (expect === undefined) { renameSync(temporary, file); return true; }
      return swap(file, temporary, expect);
    } finally { try { unlinkSync(temporary); } catch { /* renamed or gone */ } }
  }
  // from put at to without ever replacing a file there, whole in one step: a hard link. false: to exists (a writer got
  // there first). No copy instead: a copy writes the file in place, and an agent reading it meanwhile gets half (O100).
  const placeNew = (from, to) => {
    try { linkSync(from, to); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  };
  // Whether this disk has hard links: a throwaway file beside it, linked and both removed.
  const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);
  function linksWork(file) {
    const probe = file + '.p9-link-' + randomUUID();
    writeFileSync(probe, '', { mode: 0o600, flag: 'wx' });
    try { linkSync(probe, probe + '-2'); unlinkSync(probe + '-2'); return true; }
    catch (error) { if (NO_LINKS.has(error.code)) return false; throw error; }
    finally { unlinkSync(probe); }
  }
  const sameFile = (a, b) => { const x = statSync(a, { bigint: true }), y = statSync(b, { bigint: true }); return x.ino === y.ino && x.dev === y.dev; };
  // A file set aside back at its name, unless a newer file is there (then it goes). If it cannot be placed (a full disk),
  // it stays aside with its bytes and this throws with its path: nothing is deleted or replaced that was not put back.
  function restore(aside, file) {
    try { placeNew(aside, file); } catch (error) { throw Object.assign(new Error(`sprint file kept at ${aside}`), { cause: error, code: error.code }); }
    unlinkSync(aside);
  }
  // Ours out again, only if the file at the name is still ours: it is taken aside first (one step), compared there (the
  // same inode), and a newer writer's file put back. true: ours removed; false: a newer file is there.
  function takeBack(file, temporary) {
    const grab = file + '.p9-back-' + randomUUID();
    try { renameSync(file, grab); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (sameFile(grab, temporary)) { unlinkSync(grab); return true; }
    restore(grab, file);
    return false;
  }
  function swap(file, temporary, expect) {
    if (!linksWork(file)) return 'no-links';
    if (expect === '') return placeNew(temporary, file) ? true : 'changed';
    const aside = file + '.p9-old-' + randomUUID();
    try { renameSync(file, aside); } catch (error) { if (error.code === 'ENOENT') return 'changed'; throw error; } // deleted meanwhile
    const kept = () => { try { return hashOf(readFileSync(aside, 'utf8')) === expect; } catch { return false; } };
    let mine = false, newer = false;
    try {
      mine = kept() && placeNew(temporary, file);
      // Written through a handle opened before the rename: theirs wins, and ours goes only if it is still at the name.
      if (mine && !kept()) { mine = false; newer = !takeBack(file, temporary); }
    } catch (error) {
      if (!mine) restore(aside, file); // else ours is in place and the aside copy is kept
      throw error;
    }
    if (mine || newer) unlinkSync(aside); else restore(aside, file);
    return mine || 'changed';
  }
  // The review trail and the script log have one writer, P9 (trail and log below): the project page and set_rules
  // cannot write them.
  const write = (lead, name, text, expect) => (name === TRAIL || name === LOG ? false : put(lead, name, text, expect));
  // Made once, never over an edited file.
  const start = (lead, name, text) => { if (read(lead, name) === null && fileOf(lead, name)) write(lead, name, text); };
  return {
    folderOf,
    fileOf,
    read,
    write,
    trail: (lead, text) => put(lead, TRAIL, text),
    // One line per script run, the last LOG_LINES kept.
    log: (lead, line) => put(lead, LOG, [...(read(lead, LOG) ?? '').split('\n').filter(Boolean), line.replace(/[\r\n]+/g, ' ').slice(0, 300)].slice(-LOG_LINES).join('\n') + '\n'),
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
      for (const key of roles.roles.map((r) => r.key)) for (const kind of ['instructions', 'rules', 'work']) start(lead, `roles/${key}.${kind}.md`, key === 'lead' && kind === 'instructions' ? LEAD : '');
      return folderOf(lead);
    },
    // Every file of a sprint with its text, in a fixed order: plan, rules, roles.json, review trail, then roles and notes by name.
    list(lead) {
      const folder = folderOf(lead);
      if (!folder) return [];
      const names = ['sprint.md', 'rules.md', 'roles.json', TRAIL, 'hooks.json', LOG];
      for (const dir of ['roles', 'notes']) {
        try { for (const f of readdirSync(path.join(folder, dir)).sort()) names.push(dir + '/' + f); } catch { /* none */ }
      }
      return names.map((name) => ({ name, text: read(lead, name) })).filter((f) => f.text !== null).map((f) => ({ ...f, hash: hashOf(f.text) }));
    },
    // H2: every sprint folder there is now (standing merge, projects.mjs: the ones made before the switch keep merge).
    all: () => { try { return readdirSync(home).filter((n) => ID.test(n)); } catch { return []; } },
    exists: (lead) => { const folder = folderOf(lead); try { return !!folder && lstatSync(folder).isDirectory(); } catch { return false; } },
  };
}
