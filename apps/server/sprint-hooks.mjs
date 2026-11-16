// Sprint scripts (sprint spec S19; SECURITY.md § Sprint scripts; threat model row S19). A sprint's hooks.json names
// commands P9 runs at fixed points of the sprint, as the owner, outside every agent's mode. Agents can edit that file,
// so P9 never runs it: the owner's Start stores the parsed scripts in the approval record (P9's database), and only
// that copy runs. Each run gets the sprint's state as JSON on stdin (state() below is the contract, field by field) and
// leaves one line in hooks.log.
import { spawn } from 'node:child_process';
import { childEnv } from './child-env.mjs';
import { hashOf, planItems } from './sprint-files.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The four a script may refuse, then the notices.
export const BLOCKING = ['before-start', 'before-new-worker', 'before-merge', 'before-close'];
export const POINTS = [...BLOCKING, 'sprint-start', 'worker-folder-made', 'before-ready', 'ci-red', 'gate-passed', 'pause', 'resume', 'after-close'];
// The points P9 has an action for today; the rest are accepted, approved and never run (SECURITY.md says so).
export const FIRED = ['before-start', 'sprint-start', 'before-new-worker', 'worker-folder-made', 'before-ready'];
export const MAX_SCRIPTS = 12, MAX_NAME = 60, MAX_COMMAND = 200, LINE = 300;
const TIMEOUT = { blocking: 60_000, notice: 300_000 }; // ponytail: fixed, no per-script setting; add one when a real script needs longer
const KEEP = 64 * 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// One line of text safe for the page, the log and a tool result: no control characters, no table bar, single spaces, at most LINE.
export const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029|\s]+/g, ' ').trim().slice(0, LINE);

// hooks.json as text -> { scripts } (each { name, command, point, blocking }), or { error } naming the row and field.
// No file, or an empty one, is no scripts.
export function parse(text) {
  if (text === null || text === undefined || !String(text).trim()) return { scripts: [] };
  let parsed; try { parsed = JSON.parse(text); } catch { return { error: 'hooks.json is not JSON.' }; }
  const rows = parsed?.scripts;
  const shape = `hooks.json: { "scripts": [ { "name", "command", "point", "blocking"? }, ... ] }, at most ${MAX_SCRIPTS}.`;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some((k) => k !== 'scripts') || !Array.isArray(rows) || rows.length > MAX_SCRIPTS) return { error: shape };
  const scripts = [];
  for (const [i, r] of rows.entries()) {
    const at = `hooks.json, script ${i + 1}`;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => !['name', 'command', 'point', 'blocking'].includes(k))) return { error: `${at}: only name, command, point and blocking.` };
    const ok = (v, max) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= max && !CONTROL.test(v) && v.isWellFormed();
    if (!ok(r.name, MAX_NAME) || r.name.includes('|')) return { error: `${at}, name: 1 to ${MAX_NAME} characters, one line, no |.` };
    if (scripts.some((s) => s.name === r.name)) return { error: `${at}, name: "${r.name}" is used twice.` };
    if (!ok(r.command, MAX_COMMAND)) return { error: `${at} (${r.name}), command: 1 to ${MAX_COMMAND} characters, one line. It is split on spaces and run without a shell.` };
    if (!POINTS.includes(r.point)) return { error: `${at} (${r.name}), point: one of ${POINTS.join(', ')}.` };
    if (r.blocking !== undefined && typeof r.blocking !== 'boolean') return { error: `${at} (${r.name}), blocking: true or false.` };
    if (r.blocking && !BLOCKING.includes(r.point)) return { error: `${at} (${r.name}), blocking: only at ${BLOCKING.join(', ')}.` };
    scripts.push({ name: r.name, command: r.command, point: r.point, blocking: r.blocking === true });
  }
  return { scripts };
}
// What the owner is shown before approving: one line per script, the whole command.
export const said = (s) => `${s.name} (${s.point}${s.blocking ? ', blocking' : ''}): ${s.command}`;

// One run: no shell, the allow-list environment, input on stdin, the last KEEP bytes of output kept. Never throws.
// -> { exit (the code, or null), reason (null | 'timeout' | 'not-started' | 'killed'), ms, line (the last output line) }.
export function run(command, input, { cwd, timeout }) {
  const began = Date.now();
  return new Promise((resolve) => {
    const argv = command.split(/\s+/).filter(Boolean); // ponytail: split on spaces, no quoting; a path with a space needs a wrapper script
    let child, out = Buffer.alloc(0), late = false, done = false;
    const end = (exit, reason) => {
      if (done) return; done = true; clearTimeout(timer);
      const last = out.toString('utf8').split(/\r?\n/).map((l) => clean(l)).filter(Boolean).at(-1) ?? '';
      resolve({ exit, reason, ms: Date.now() - began, line: last });
    };
    // ponytail: the child alone is ended; a program it started is not followed (SECURITY.md § Sprint scripts).
    const timer = setTimeout(() => { late = true; try { child?.kill('SIGKILL'); } catch { /* gone */ } }, timeout);
    try { child = spawn(argv[0], argv.slice(1), { cwd, env: childEnv(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { end(null, 'not-started'); return; }
    const keep = (chunk) => { out = Buffer.concat([out, chunk]); if (out.length > KEEP) out = out.subarray(out.length - KEEP); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', () => end(null, 'not-started'));
    child.on('close', (code) => end(late ? null : code, late ? 'timeout' : code === null ? 'killed' : null));
    child.stdin.on('error', () => {}); // a script that never reads its input
    child.stdin.end(input);
  });
}

// chat: the chat service; usage: () => what GET /usage answers (or absent); stateOf, rolesOf: delegate's own.
export function createHooks({ chat, usage, stateOf, rolesOf }) {
  const approved = (sprint) => { const s = chat.projects.started(sprint)?.scripts; return Array.isArray(s) ? s : []; };
  const logLines = (sprint, n = 20) => (chat.sprintFiles.read(sprint, 'hooks.log') ?? '').split('\n').filter(Boolean).slice(-n);
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

  // The data contract, version 1 (SECURITY.md § Sprint scripts, "What a script is told"). Every field is always there;
  // one P9 has nothing for is null or empty, never missing. Nothing here is more than the project page and list_chats
  // show for this sprint: no key, no provider profile's address, no chat text.
  async function state(sprint, point, subject) {
    const family = chat.family(), lead = family.find((c) => c.id === sprint), prep = chat.projects.prepOf(sprint), start = chat.projects.started(sprint);
    const projectId = lead?.project ?? prep?.project ?? null, project = projectId ? await chat.projects.record(projectId) : null;
    const listed = new Map(chat.list().map((c) => [c.id, c]));
    const chats = [...(lead ? [lead] : []), ...family.filter((c) => c.parent === sprint)];
    const workers = [], verdicts = [];
    for (const c of chats) {
      const info = chat.info(c.id), row = listed.get(c.id), mine = chat.sprint(c.id), gauge = chat.gauge(c.id);
      if (!info) continue;
      workers.push({ chat: c.id, key: c.id === sprint ? 'lead' : c.key ?? null, title: info.title, provider: info.provider, profile: info.profile?.id ?? null,
        model: info.model ?? gauge?.model ?? null, effort: info.effort?.value ?? null, mode: info.mode ?? null, state: stateOf(info), waiting: Boolean(row?.waiting),
        context: gauge?.context ?? null, folder: await chat.startFolder(c.id), active: iso(row?.used),
        task: mine.task ? { item: mine.task.item } : null,
        ready: mine.ready ? { item: mine.ready.item, commit: mine.ready.commit, at: iso(mine.ready.at) } : null,
        verdict: mine.verdict ? { result: mine.verdict.result ?? null, by: mine.verdict.by ?? null, at: iso(mine.verdict.at), note: clean(mine.verdict.note ?? '') } : null });
      if (c.id !== sprint) for (const [item, r] of Object.entries(mine.reviews ?? {}))
        verdicts.push({ item, worker: c.key ?? null, chat: c.id, commit: r.commit ?? null, state: r.state, fixes: r.fixes ?? 0, larger: Boolean(r.larger), at: iso(r.at), by: r.by ?? null });
    }
    const roles = rolesOf(sprint), rows = roles.error ? [] : [roles.lead, ...roles.rest];
    const limits = usage ? await Promise.resolve().then(usage).catch(() => null) : null;
    return {
      contract: 1, point, blocking: false, script: { name: '' }, at: new Date().toISOString(),
      sprint: { id: sprint, title: lead?.title ?? prep?.title ?? null, folder: chat.sprintFiles.folderOf(sprint),
        started: start ? { at: iso(start.at), by: start.by, plan: start.plan } : null },
      project: projectId ? { id: projectId, name: project?.name ?? null } : null,
      phase: null, // reserved: the plan has items only
      roles: rows.map((r) => ({ key: r.key, provider: r.profile ? 'profile:' + r.profile : r.provider, model: r.model ?? null, effort: r.effort ?? null, mode: r.mode ?? null })),
      items: planItems(chat.sprintFiles.read(sprint, 'sprint.md')).map((i) => { const v = verdicts.find((r) => r.item === i.id);
        return { ...i, review: v ? { state: v.state, commit: v.commit, fixes: v.fixes, larger: v.larger, at: v.at } : null }; }),
      workers, subject: subject ?? null,
      pr: null, // reserved: P9 tracks no pull request or CI run yet
      verdicts,
      usage: limits ? { totals: limits.totals ?? null, limits: limits.limits ?? null } : null,
      log: logLines(sprint),
    };
  }

  const record = (sprint, s, r) => {
    const how = r.reason ? r.reason : 'exit ' + r.exit;
    try { chat.sprintFiles.log(sprint, `${new Date().toISOString()} | ${s.point} | ${s.name} | ${how} | ${r.ms} ms | ${r.line}`); } catch { /* the run stands; the file is a convenience */ }
  };
  // Runs the approved scripts of one point, in the file's order. A blocking one that fails refuses: the rest do not run
  // and { error: 'script-refused', ... } comes back. Notices are started and not waited for. null: go on.
  // scripts: only Start passes it (the list being approved by this very press, not yet recorded).
  async function fire(sprint, point, subject, scripts = approved(sprint)) {
    const due = scripts.filter((s) => s.point === point);
    if (!due.length || !ID.test(sprint ?? '')) return null;
    const cwd = chat.sprintFiles.folderOf(sprint);
    let base; try { base = await state(sprint, point, subject); } catch { base = { contract: 1, point, error: 'state-unavailable' }; }
    for (const s of due) {
      const blocking = s.blocking && BLOCKING.includes(point);
      const going = run(s.command, JSON.stringify({ ...base, blocking, script: { name: s.name } }), { cwd, timeout: blocking ? TIMEOUT.blocking : TIMEOUT.notice })
        .then((r) => { record(sprint, s, r); return r; });
      if (!blocking) { going.catch(() => {}); continue; }
      const r = await going;
      if (r.exit !== 0) {
        const why = r.reason === 'timeout' ? `ran past ${TIMEOUT.blocking / 1000} seconds` : r.reason === 'not-started' ? 'could not be started' : r.reason === 'killed' ? 'was ended by a signal' : 'exit ' + r.exit;
        return { error: 'script-refused', script: s.name, point, exit: r.exit, detail: `The sprint's script "${s.name}" (${point}) refused this: ${why}${r.line ? ': ' + r.line : '.'}` };
      }
    }
    return null;
  }

  // sprint_scripts: what is approved, what the file holds now, whether they differ, the last runs. Reads only.
  function read(caller, named) {
    const me = chat.info(caller);
    if (!me) return { error: 'unknown-sprint' };
    const sprint = named ?? (chat.sprintFiles.exists(caller) ? caller : me.parent);
    if (!ID.test(sprint ?? '') || !chat.sprintFiles.exists(sprint)) return { error: 'unknown-sprint', detail: 'Name a sprint: an id from new_sprint, or call this from a sprint\'s lead or one of its workers.' };
    const project = chat.info(sprint)?.project ?? chat.projects.prepOf(sprint)?.project ?? null;
    if (sprint !== caller && sprint !== me.parent && (!project || project !== me.project)) return { error: 'unknown-sprint' };
    const text = chat.sprintFiles.read(sprint, 'hooks.json'), file = parse(text), start = chat.projects.started(sprint), ok = approved(sprint);
    return {
      sprint, points: POINTS, blocking: BLOCKING, fired: FIRED,
      approved: start ? { at: iso(start.at), by: start.by, scripts: ok } : null,
      file: file.error ? { error: file.error } : { scripts: file.scripts, ...(text !== null && { hash: hashOf(text) }) },
      pending: Boolean(file.error) || JSON.stringify(file.scripts) !== JSON.stringify(ok),
      log: logLines(sprint),
      note: 'Only the approved scripts run. A change to hooks.json runs after the user starts the sprint again and approves it; no tool approves or runs a script.',
    };
  }
  return { fire, read, approved };
}
