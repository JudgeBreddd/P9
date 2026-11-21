// Sprint scripts (sprint spec S19; SECURITY.md § Sprint scripts; threat model row S19). A sprint's hooks.json names
// commands P9 runs at fixed points of the sprint, as the owner, outside every agent's mode. Agents can edit that file,
// so P9 never runs it: the owner's Start stores the parsed scripts in the approval record (P9's database), and only
// that copy runs. Each run gets the sprint's state as JSON on stdin (state() below is the contract, field by field) and
// leaves one line in hooks.log.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { childEnv } from './child-env.mjs';
import { hashOf, phasesOf, planItems } from './sprint-files.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The four a script may refuse, then the notices.
// O162 PRs an hour: items merged (each item is one PR) per hour since Start, to one decimal. Within the first hour it is
// the count merged so far, which is that hour's count: no huge rate from a few minutes' run.
const perHour = (merged, ms) => Math.round((merged * 10) / Math.max(1, ms / 3_600_000)) / 10;
// O162 (usage): what the sprint's chats have used so far, each field the sum of every chat's spent (list_chats' fold);
// null until one has reported any. A field a chat does not report counts 0.
const SPENT = ['inputTokens', 'outputTokens', 'cachedTokens', 'costUsd', 'turns'];
const spentOf = (workers) => {
  const got = workers.map((w) => w.spent).filter(Boolean);
  return got.length ? Object.fromEntries(SPENT.map((k) => [k, got.reduce((n, x) => n + (Number.isFinite(x[k]) && x[k] >= 0 ? x[k] : 0), 0)])) : null;
};
export const BLOCKING = ['before-start', 'before-new-worker', 'before-merge', 'before-close'];
// every (O189): not a step of the sprint but a clock. Its row says "every": N minutes (EVERY_MIN to EVERY_MAX), and P9
// runs it again and again while the sprint is started, not paused and not closed (tick, in createHooks).
export const POINTS = [...BLOCKING, 'sprint-start', 'worker-folder-made', 'before-ready', 'ci-red', 'gate-passed', 'pause', 'resume', 'after-close', 'every'];
// O202: every point now runs. Three of them are things P9 does not do itself (it merges nothing, runs no CI, passes no
// gate), so the sprint's lead reports them with the sprint_event tool (REPORTED, event() below); pause and resume run at
// Pause and Resume (ordered() below).
export const REPORTED = ['before-merge', 'ci-red', 'gate-passed'];
export const FIRED = POINTS;
export const EVERY_MIN = 10, EVERY_MAX = 120;
export const MAX_SCRIPTS = 12, MAX_LIBRARY = 100, MAX_NAME = 60, MAX_COMMAND = 200, LINE = 300;
const TIMEOUT = { blocking: 60_000, notice: 300_000 }; // ponytail: fixed, no per-script setting; add one when a real script needs longer
const KEEP = 64 * 1024;
// O189: what one script run may send its sprint's chats through POST /script (say, below): calls per run, characters per text.
const SAY_CALLS = 20, SAY_MAX = 20_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// One line of text safe for the page, the log and a tool result: no control characters, no table bar, single spaces, at most LINE.
export const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029|\s]+/g, ' ').trim().slice(0, LINE);

// hooks.json as text -> { scripts } (each { name, command, point, blocking, notify?, every? }), or { error } naming the row and field.
// every: the minutes between two runs, on a row at point every and only there (each needs the other).
// notify (O189 2b): one chat outside the sprint (a chat id, e.g. the coordinator) this script's POST /script may also reach.
// No file, or an empty one, is no scripts. The library (S18) is the same list under another name and a larger limit.
export function parse(text, what = 'hooks.json', max = MAX_SCRIPTS) {
  if (text === null || text === undefined || !String(text).trim()) return { scripts: [] };
  let parsed; try { parsed = JSON.parse(text); } catch { return { error: `${what} is not JSON.` }; }
  const rows = parsed?.scripts;
  const shape = `${what}: { "scripts": [ { "name", "command", "point", "blocking"? }, ... ] }, at most ${max}.`;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some((k) => k !== 'scripts') || !Array.isArray(rows) || rows.length > max) return { error: shape };
  const scripts = [];
  for (const [i, r] of rows.entries()) {
    const at = `${what}, script ${i + 1}`;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => !['name', 'command', 'point', 'blocking', 'notify', 'every'].includes(k))) return { error: `${at}: only name, command, point, blocking, notify and every.` };
    const ok = (v, max) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= max && !CONTROL.test(v) && v.isWellFormed();
    if (!ok(r.name, MAX_NAME) || r.name.includes('|')) return { error: `${at}, name: 1 to ${MAX_NAME} characters, one line, no |.` };
    if (scripts.some((s) => s.name === r.name)) return { error: `${at}, name: "${r.name}" is used twice.` };
    if (!ok(r.command, MAX_COMMAND)) return { error: `${at} (${r.name}), command: 1 to ${MAX_COMMAND} characters, one line. It is split on spaces and run without a shell.` };
    if (!POINTS.includes(r.point)) return { error: `${at} (${r.name}), point: one of ${POINTS.join(', ')}.` };
    if (r.blocking !== undefined && typeof r.blocking !== 'boolean') return { error: `${at} (${r.name}), blocking: true or false.` };
    if (r.blocking && !BLOCKING.includes(r.point)) return { error: `${at} (${r.name}), blocking: only at ${BLOCKING.join(', ')}.` };
    if (r.notify !== undefined && !(typeof r.notify === 'string' && ID.test(r.notify))) return { error: `${at} (${r.name}), notify: a chat id.` };
    if ((r.point === 'every') !== (r.every !== undefined) || (r.every !== undefined && !(Number.isInteger(r.every) && r.every >= EVERY_MIN && r.every <= EVERY_MAX)))
      return { error: `${at} (${r.name}), every: the point every needs "every": a whole number of minutes, ${EVERY_MIN} to ${EVERY_MAX}, and no other point takes it.` };
    scripts.push({ name: r.name, command: r.command, point: r.point, blocking: r.blocking === true, ...(r.notify && { notify: r.notify }), ...(r.every !== undefined && { every: r.every }) });
  }
  return { scripts };
}
// What the owner is shown before approving: one line per script, the whole command.
const DRAIN = 250; // ms after the script ends for its last output to arrive
// An every row says it repeats (new trust: one yes runs it many times).
export const said = (s) => `${s.name} (${s.point === 'every' ? `repeats every ${s.every} minutes while the sprint is started and not paused, until it is closed` : s.point}${s.blocking ? ', blocking' : ''}${s.notify ? ', may also message chat ' + s.notify : ''}): ${s.command}`;

// One run: no shell, the allow-list environment, input on stdin, the last KEEP bytes of output kept. Never throws.
// -> { exit (the code, or null), reason (null | 'timeout' | 'not-started' | 'killed'), ms, line (the last output line) }.
// say: O189's { socket, token, ended } for this run, given as P9_SCRIPT_SOCKET and P9_SCRIPT_TOKEN. The token is cut out of
// the output kept, so a script that prints it does not put it in hooks.log or a refusal. ended() revokes it the moment the
// script itself exits, is killed or cannot start: not after the output drains, so a program the script left holding
// its output (and its environment) cannot use the token past the script's own end.
export function run(command, input, { cwd, timeout, say }) {
  const began = Date.now();
  return new Promise((resolve) => {
    const argv = command.split(/\s+/).filter(Boolean); // ponytail: split on spaces, no quoting; a path with a space needs a wrapper script
    let child, out = Buffer.alloc(0), late = false, done = false, drain;
    const ended = () => { try { say?.ended?.(); } catch { /* revoking never fails the run */ } };
    const end = (exit, reason) => {
      ended();
      if (done) return; done = true; clearTimeout(timer); clearTimeout(drain);
      // The pipes are let go here: a program the script started may hold them open long after it.
      for (const pipe of [child?.stdin, child?.stdout, child?.stderr]) { try { pipe?.destroy(); } catch { /* closed */ } }
      const token = say?.token, kept = out.toString('utf8');
      const last = (token ? kept.replaceAll(token, '[token]') : kept).split(/\r?\n/).map((l) => clean(l)).filter(Boolean).at(-1) ?? '';
      resolve({ exit, reason, ms: Date.now() - began, line: last });
    };
    // ponytail: the child alone is ended; a program it started is not followed (SECURITY.md § Sprint scripts).
    const timer = setTimeout(() => { late = true; try { child?.kill('SIGKILL'); } catch { /* gone */ } end(null, 'timeout'); }, timeout);
    try { child = spawn(argv[0], argv.slice(1), { cwd, env: { ...childEnv(), ...(say ? { P9_SCRIPT_SOCKET: say.socket, P9_SCRIPT_TOKEN: say.token } : {}) }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { end(null, 'not-started'); return; }
    const keep = (chunk) => { out = Buffer.concat([out, chunk]); if (out.length > KEEP) out = out.subarray(out.length - KEEP); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', () => end(null, 'not-started'));
    // The script's own end settles the run: 'close' alone would wait for every program holding its output.
    child.on('exit', (code) => { ended(); drain = setTimeout(() => end(late ? null : code, late ? 'timeout' : code === null ? 'killed' : null), DRAIN); });
    child.on('close', (code) => end(late ? null : code, late ? 'timeout' : code === null ? 'killed' : null));
    child.stdin.on('error', () => {}); // a script that never reads its input
    child.stdin.end(input);
  });
}

// chat: the chat service; usage: () => what GET /usage answers (or absent); stateOf, rolesOf: delegate's own.
// minute, bootAt: the every point's clock (tests give a short minute and drive tick themselves; ticking: false).
export function createHooks({ chat, usage, stateOf, rolesOf, allowed, minute = 60_000, bootAt = Date.now(), ticking = true }) {
  const approved = (sprint) => { const s = chat.projects.started(sprint)?.scripts; return Array.isArray(s) ? s : []; };
  // Scripts added after Start (sprint spec S20; SECURITY.md § Sprint scripts, "Scripts added after Start"; threat model
  // row S20). A hooks.json row that is new, or differs in any field from the Start-approved row of its name, is an
  // additional script. The owner's switch "Allow additional scripts" on: it runs as the file says. Off: it runs only
  // as the exact row the owner approved since Start (kept in the start record as extra). A row approved at Start runs
  // until the next Start, whatever the file says. running: what fire and Run now use, and nothing else decides it.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // O189: a running script's way to its sprint's chats (POST /script, server.mjs; SECURITY.md § Sprint scripts). One
  // token per run, made just before the spawn and dropped when the run ends, so it works only while that run runs.
  const callers = new Map(); // token -> { sprint, name, calls }
  const speaking = async (sprint, name, go, notify) => {
    if (!chat.socketPath) return go(undefined); // no daemon socket (tests without one): nothing to call
    const token = randomBytes(32).toString('hex');
    callers.set(token, { sprint, name, notify, calls: 0 });
    try { return await go({ socket: chat.socketPath, token, ended: () => callers.delete(token) }); } finally { callers.delete(token); }
  };
  // note: starts no turn. prompt: always a queued message, never a steer. Only to the sprint's lead, a chat under it or
  // the lead's parent, or the one chat its approved row names (notify, O189 2b); both are P9's, with a first line naming
  // the script, never the user's. At most SAY_CALLS per run.
  async function say(token, body) {
    let at = null;
    if (typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)) for (const [t, c] of callers) if (timingSafeEqual(Buffer.from(t), Buffer.from(token))) at = c;
    if (!at) return { status: 401, error: 'login-required' };
    const { action, chat: to, text } = body && typeof body === 'object' ? body : {};
    if (!['note', 'prompt'].includes(action) || !ID.test(typeof to === 'string' ? to : '') || typeof text !== 'string' || !text.trim() || text.length > SAY_MAX)
      return { status: 400, error: 'request-refused', detail: `{ action: "note" or "prompt", chat: a chat id, text: 1 to ${SAY_MAX} characters }` };
    // A live token never goes into a chat's history or a parked note: refused, not scrubbed.
    for (const t of callers.keys()) if (text.includes(t)) return { status: 400, error: 'request-refused', detail: 'The text holds a script token.' };
    // Counted once the request is well formed, so a malformed one does not use the run's budget up.
    if ((at.calls += 1) > SAY_CALLS) return { status: 429, error: 'too-many-calls', detail: `A script run sends at most ${SAY_CALLS} notes and prompts.` };
    if (chat.projects.closed(at.sprint)) return { status: 409, error: 'sprint-closed' };
    const family = chat.family(), parent = family.find((c) => c.id === at.sprint)?.parent;
    if (to !== at.sprint && to !== parent && to !== at.notify && !family.some((c) => c.id === to && c.parent === at.sprint))
      return { status: 422, error: 'not-this-sprints', detail: 'A script reaches its own sprint\'s lead, the chats under it, the lead\'s parent and the chat its row names (notify).' };
    const line = `[P9: from sprint script ${at.name}, not from the user.]\n\n` + text;
    const r = action === 'note' ? await chat.note(to, line, 'p9') : await chat.prompt(to, { text: line, when: 'queue' }, undefined, 'p9');
    if (r?.error || r?.status >= 400) return { status: r.status >= 400 ? r.status : 409, error: r.error ?? 'not-sent' };
    return { status: 200, chat: to, sent: action === 'note' ? 'note' : 'queued' };
  }
  const extras = (sprint) => { const s = chat.projects.started(sprint)?.extra; return Array.isArray(s) ? s : []; };
  // text: the hooks.json a caller has already read (and hashed), so its rows and its hash are of the same bytes;
  // left out, the file is read here.
  function standing(sprint, text) {
    // A closed sprint runs nothing (Close sprint turns its scripts off; its own two points are given their list by closeSprint).
    if (!chat.projects.started(sprint) || chat.projects.closed(sprint)) return { running: [], additional: [], waiting: [] };
    const base = approved(sprint), file = parse(text === undefined ? chat.sprintFiles.read(sprint, 'hooks.json') : text).scripts ?? [];
    const over = chat.allowScripts() ? file.filter((f) => !base.some((b) => same(b, f))) : extras(sprint);
    const running = [...base.map((b) => over.find((o) => o.name === b.name) ?? b), ...over.filter((o) => !base.some((b) => b.name === o.name))];
    return { running, additional: running.filter((r) => !base.some((b) => same(b, r))), waiting: file.filter((f) => !running.some((r) => same(r, f))) };
  }
  const logLines = (sprint, n = 20) => (chat.sprintFiles.read(sprint, 'hooks.log') ?? '').split('\n').filter(Boolean).slice(-n);
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

  // The data contract, version 1 (SECURITY.md § Sprint scripts, "What a script is told"). Every field is always there;
  // one P9 has nothing for is null or empty, never missing. Nothing here is more than the project page and list_chats
  // show for this sprint: no key, no provider profile's address, no chat text.
  // https://user:token@host/o/r -> https://host/o/r; git@host:o/r -> host:o/r; a ?query or #fragment goes too (a token
  // can ride there). What is left must be plain host-and-path characters, or the script gets null: an encoded or odd
  // form (%40, ;token=, a second @) is never guessed at.
  const bare = (address) => {
    const left = address.replace(/[?#].*$/s, '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1').replace(/^[^:/@]+@(?=[^:/]+:)/, '');
    return /^[A-Za-z0-9._~:/-]+$/.test(left) ? left : null;
  };
  async function state(sprint, point, subject) {
    const family = chat.family(), lead = family.find((c) => c.id === sprint), prep = chat.projects.prepOf(sprint), start = chat.projects.started(sprint);
    const projectId = lead?.project ?? prep?.project ?? null, project = projectId ? await chat.projects.record(projectId) : null;
    const source = projectId ? (await chat.projects.sprintSet?.(projectId))?.source || null : null;
    const listed = new Map(chat.list().map((c) => [c.id, c]));
    const chats = [...(lead ? [lead] : []), ...family.filter((c) => c.parent === sprint)];
    const workers = [], verdicts = [];
    for (const c of chats) {
      const info = chat.info(c.id), row = listed.get(c.id), mine = chat.sprint(c.id), gauge = chat.gauge(c.id);
      if (!info) continue;
      workers.push({ chat: c.id, key: c.id === sprint ? 'lead' : c.key ?? null, title: info.title, provider: info.provider, profile: info.profile?.id ?? null,
        model: info.model ?? gauge?.model ?? null, effort: info.effort?.value ?? null, mode: info.mode ?? null, state: stateOf(info), waiting: Boolean(row?.waiting),
        context: gauge?.context ?? null, spent: gauge?.spent ?? null, folder: await chat.startFolder(c.id), active: iso(row?.used),
        task: mine.task ? { item: mine.task.item } : null,
        ready: mine.ready ? { item: mine.ready.item, commit: mine.ready.commit, at: iso(mine.ready.at) } : null,
        verdict: mine.verdict ? { result: mine.verdict.result ?? null, by: mine.verdict.by ?? null, at: iso(mine.verdict.at), note: clean(mine.verdict.note ?? '') } : null });
      if (c.id !== sprint) for (const [item, r] of Object.entries(mine.reviews ?? {}))
        verdicts.push({ item, worker: c.key ?? null, chat: c.id, commit: r.commit ?? null, state: r.state, fixes: r.fixes ?? 0, larger: Boolean(r.larger), merged: r.merged === true, at: iso(r.at), by: r.by ?? null });
    }
    const roles = rolesOf(sprint), rows = roles.error ? [] : [roles.lead, ...roles.rest];
    const limits = usage ? await Promise.resolve().then(usage).catch(() => null) : null;
    return {
      contract: 1, point, blocking: false, script: { name: '' }, at: new Date().toISOString(),
      sprint: { id: sprint, title: lead?.title ?? prep?.title ?? null, folder: chat.sprintFiles.folderOf(sprint),
        started: start ? { at: iso(start.at), by: start.by, plan: start.plan } : null },
      // O211: the project's Clone from, so a script finds its repository; any user name and password are taken out first.
      project: projectId ? { id: projectId, name: project?.name ?? null, source: source && bare(source) } : null,
      phase: null, // reserved: the plan has items only
      roles: rows.map((r) => ({ key: r.key, provider: r.profile ? 'profile:' + r.profile : r.provider, model: r.model ?? null, effort: r.effort ?? null, mode: r.mode ?? null, owns: r.owns ?? null })),
      items: planItems(chat.sprintFiles.read(sprint, 'sprint.md')).map((i) => { const v = verdicts.find((r) => r.item === i.id);
        return { ...i, review: v ? { state: v.state, commit: v.commit, fixes: v.fixes, larger: v.larger, merged: v.merged, at: v.at } : null }; }),
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
  // Runs the approved scripts of one point (standing: Start's, and the additional ones the owner allows), in order. A blocking one that fails refuses: the rest do not run
  // and { error: 'script-refused', ... } comes back. Notices are started and not waited for. null: go on.
  // scripts: only Start passes it (the list being approved by this very press, not yet recorded).
  // onNotice: given each notice's run (a promise), for a caller that must know when they end (event, ordered).
  // H2: the answer while the owner's standing-merge switch is off.
  const OWNERS = { error: 'merge-is-the-owners', detail: 'The owner has not turned on standing merge for this sprint: do not merge. Tell the owner the PR is ready to merge.' };
  async function fire(sprint, point, subject, scripts, onNotice) {
    // O202: the sprint's own list (no list given) is checked again right before each start, after the state read and
    // each blocking script waited: a sprint closed, deleted, started again or P9 shutting down meanwhile starts nothing
    // more (a blocking point is refused). The lists Start and Close hand in (before-start, before-close, after-close)
    // are run as given: those points are about the sprint not being started, or being closed, by definition.
    const own = scripts === undefined, at = chat.projects.started(sprint)?.at ?? 0;
    const open = () => !own || (!off() && chat.family().some((c) => c.id === sprint) && (chat.projects.started(sprint)?.at ?? null) === at && !chat.projects.closed(sprint));
    const due = (own ? standing(sprint).running : scripts).filter((s) => s.point === point);
    if (!due.length || !ID.test(sprint ?? '')) return null;
    const cwd = chat.sprintFiles.folderOf(sprint);
    let base; try { base = await state(sprint, point, subject); } catch { base = { contract: 1, point, error: 'state-unavailable' }; }
    for (const s of due) {
      const blocking = s.blocking && BLOCKING.includes(point);
      // H2: the owner's switch turned off meanwhile starts no more before-merge script (SECURITY.md § Standing merge).
      if (own && point === 'before-merge' && !chat.projects.merge(sprint)) return { ...OWNERS };
      if (!open()) return BLOCKING.includes(point) ? { error: 'sprint-gone', point, detail: 'The sprint was closed, deleted or started again, or P9 began shutting down, before its script started; nothing more ran.' } : null;
      const going = speaking(sprint, s.name, (say) => run(s.command, JSON.stringify({ ...base, blocking, script: { name: s.name } }), { cwd, timeout: blocking ? TIMEOUT.blocking : TIMEOUT.notice, say }), s.notify)
        .then((r) => { record(sprint, s, r); return r; });
      if (!blocking) { going.catch(() => {}); onNotice?.(going); continue; }
      const r = await going;
      if (r.exit !== 0) {
        const why = r.reason === 'timeout' ? `ran past ${TIMEOUT.blocking / 1000} seconds` : r.reason === 'not-started' ? 'could not be started' : r.reason === 'killed' ? 'was ended by a signal' : 'exit ' + r.exit;
        return { error: 'script-refused', script: s.name, point, exit: r.exit, detail: `The sprint's script "${s.name}" (${point}) refused this: ${why}${r.line ? ': ' + r.line : '.'}` };
      }
    }
    return null;
  }

  // O202, pause and resume: run one after the other per sprint, each once the last one's scripts have all ended, so a quick
  // Pause then Resume cannot have the resume script (heavy-services resume) finish before the pause script (pause) and
  // leave the services paused in a running sprint. A run still waiting when the sprint is closed runs nothing (standing()
  // lists no scripts for a closed sprint, and fire() checks again right before each start): a pause script after Close
  // would undo what after-close put back. One still waiting while P9 shuts down is dropped. Each run is a notice; nothing
  // waits for it. Callers queue a run at the moment the sprint changes, before anything of theirs waits, so the runs
  // are in the order of the presses (resumeSprint queues inside chat.resume, before the kept messages are sent).
  const chains = new Map();
  function ordered(sprint, point, subject) {
    const next = (chains.get(sprint) ?? Promise.resolve()).then(async () => {
      if (off()) return;
      const going = [];
      await fire(sprint, point, subject, undefined, (p) => going.push(p));
      await Promise.allSettled(going);
    }).catch(() => {});
    chains.set(sprint, next);
    next.then(() => { if (chains.get(sprint) === next) chains.delete(sprint); });
    return next;
  }
  // O202, the reported points: the sprint's lead calls sprint_event right before it merges (before-merge, blocking: a
  // refusal comes back and the lead must not merge), when a CI run went red (ci-red) or when a gate passed (gate-passed).
  // Only the lead of a started, not closed sprint; only the approved scripts of that point run. One call of a point at a
  // time per sprint: while the last call's scripts run, another is refused (point-busy), so a loop cannot pile up runs.
  const busy = new Set();
  const SUBJECT = { pr: (v) => Number.isInteger(v) && v > 0 && v < 1e9, run: (v) => typeof v === 'string' && /^[0-9]{1,20}$/.test(v),
    commit: (v) => typeof v === 'string' && /^[0-9a-f]{7,40}$/.test(v), branch: (v) => typeof v === 'string' && v.length <= 200 && v === clean(v) && v !== '',
    item: (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{1,60}$/.test(v), gate: (v) => typeof v === 'string' && v.length <= 60 && v === clean(v) && v !== '' };
  async function event(caller, args) {
    if (chat.lock(caller).on) return { error: 'agent-lock-on' };
    if (!ID.test(caller ?? '') || !chat.info(caller) || !chat.sprintFiles.exists(caller)) return { error: 'not-a-sprint-lead', detail: 'Only a sprint\'s lead reports a merge, a red CI run or a passed gate.' };
    const point = args?.point, subject = args?.subject === undefined ? {} : args.subject; // null is refused below, not taken as none
    if (!REPORTED.includes(point)) return { error: 'request-refused', detail: 'point is one of ' + REPORTED.join(', ') + '.' };
    if (typeof subject !== 'object' || Array.isArray(subject) || subject === null) return { error: 'request-refused', detail: 'subject is an object.' };
    for (const [k, v] of Object.entries(subject)) if (!SUBJECT[k]?.(v)) return { error: 'request-refused', detail: `subject.${k} is refused: the fields are pr (a number), run (digits), commit (hex), branch, item and gate.` };
    if (chat.projects.closed(caller)) return { error: 'sprint-closed' };
    if (!chat.projects.started(caller)) return { error: 'sprint-not-started', detail: 'Nothing runs before Start: Start approves the scripts.' };
    // H2 (SECURITY.md § Standing merge): with the owner's standing-merge switch off, merge is the owner's; the scripts do
    // not run for a merge the lead may not make. It binds only a lead that reports before it merges.
    if (point === 'before-merge' && !chat.projects.merge(caller)) return { ...OWNERS };
    const key = caller + '\n' + point;
    if (busy.has(key)) return { error: 'point-busy', detail: `The ${point} scripts of your last call are still running; call again when they end.` };
    busy.add(key);
    const going = [], due = standing(caller).running.filter((s) => s.point === point).length;
    let refused;
    try { refused = await fire(caller, point, { ...subject, by: 'lead' }, undefined, (p) => going.push(p)); }
    finally { Promise.allSettled(going).then(() => busy.delete(key)); }
    if (refused) return refused;
    // H2: the owner may turn the switch off, or close the sprint, while the before-merge scripts run: read both again
    // after the awaits, so "allowed" is only said for a merge still allowed now.
    if (point === 'before-merge' && chat.projects.closed(caller)) return { error: 'sprint-closed' };
    if (point === 'before-merge' && !chat.projects.merge(caller)) return { ...OWNERS };
    return { point, scripts: due, ...(point === 'before-merge' && { merge: 'allowed' }) };
  }

  // O189 (1), the every point. One tick a minute looks at every started sprint that is not paused or closed and runs
  // each standing every row whose N minutes have passed since its last run. The first wait is counted from Start, or
  // from P9's own start when that is later, so a restart does not run every row at once. A row whose last run is still
  // going skips the tick and runs on the first tick after it ends; a pause or a long run is caught up with one run, never
  // several. Each run is a notice (a failure is only logged, the row keeps its clock) with its own #328 token, made
  // through speaking like every other run. ponytail: last runs live in memory; a restart waits N minutes again.
  // The clock is kept per Start: a new Start counts its first wait afresh, but a run still going from before it is still
  // waited for (never two runs of one row at once). Right before the spawn, after every await (the state read, the
  // token), the row is checked again: the lead still there (not deleted), still this Start, not paused or closed, still standing as it was read, and P9 not
  // shutting down. Shutdown (chat.closing) stops the timer and every launch not yet spawned.
  const last = new Map(); // sprint + '\n' + name -> { at, going, start: the Start record's at it was run under }
  let timer = null, stopped = false;
  const stop = () => { stopped = true; if (timer) clearInterval(timer); timer = null; };
  const off = () => stopped || chat.closing?.() === true;
  const stands = (sprint, s, at) => { const start = chat.projects.started(sprint);
    return !off() && chat.family().some((c) => c.id === sprint) && Boolean(start) && (start.at ?? 0) === at && !chat.projects.closed(sprint) && !chat.paused?.(sprint) && standing(sprint).running.some((x) => same(x, s)); };
  function tick(now = Date.now()) {
    if (off()) { stop(); return Promise.resolve([]); }
    const runs = [];
    for (const { id: sprint } of chat.family()) {
      const start = chat.projects.started(sprint);
      if (!start || !ID.test(sprint) || chat.projects.closed(sprint) || chat.paused?.(sprint)) continue;
      const at = start.at ?? 0;
      for (const s of standing(sprint).running) {
        if (s.point !== 'every' || !Number.isInteger(s.every)) continue;
        const key = sprint + '\n' + s.name, was = last.get(key);
        if (was?.going || now - (was?.start === at ? was.at : Math.max(at, bootAt)) < s.every * minute) continue;
        const mine = { at: now, going: true, start: at };
        last.set(key, mine); // before any wait, so a tick that overlaps this one sees the run going
        let ran = false;
        runs.push((async () => {
          let base; try { base = await state(sprint, 'every', { every: s.every }); } catch { base = { contract: 1, point: 'every', error: 'state-unavailable' }; }
          if (!stands(sprint, s, at)) return null;
          const r = await speaking(sprint, s.name, (say) => { if (!stands(sprint, s, at)) return null; ran = true; return run(s.command, JSON.stringify({ ...base, blocking: false, script: { name: s.name } }), { cwd: chat.sprintFiles.folderOf(sprint), timeout: TIMEOUT.notice, say }); }, s.notify);
          if (r) record(sprint, s, r);
          return r;
        })().catch(() => null).finally(() => {
          mine.going = false;
          if (!ran && last.get(key) === mine) { if (was) last.set(key, was); else last.delete(key); } // nothing ran: the clock is as it was
        }));
      }
    }
    return Promise.all(runs);
  }
  if (ticking) { timer = setInterval(() => { try { tick(); } catch { /* the next tick tries again */ } }, Math.min(minute, 60_000)); timer.unref?.(); }

  // sprint_scripts: what is approved, what the file holds now, whether they differ, the last runs. Reads only.
  // The sprint a tool call means: the one named (in the caller's project), else the caller's own.
  function where(caller, named) {
    const me = chat.info(caller);
    if (!me) return { error: 'unknown-sprint' };
    const sprint = named ?? (chat.sprintFiles.exists(caller) ? caller : me.parent);
    if (!ID.test(sprint ?? '') || !chat.sprintFiles.exists(sprint)) return { error: 'unknown-sprint', detail: 'Name a sprint: an id from new_sprint, or call this from a sprint\'s lead or one of its workers.' };
    const project = chat.info(sprint)?.project ?? chat.projects.prepOf(sprint)?.project ?? null;
    if (sprint !== caller && sprint !== me.parent && (!project || project !== me.project)) return { error: 'unknown-sprint' };
    return { sprint };
  }
  function read(caller, named) {
    const { sprint, ...no } = where(caller, named);
    if (no.error) return no;
    const text = chat.sprintFiles.read(sprint, 'hooks.json'), file = parse(text), start = chat.projects.started(sprint), ok = approved(sprint), st = standing(sprint);
    return {
      sprint, points: POINTS, blocking: BLOCKING, fired: FIRED,
      approved: start ? { at: iso(start.at), by: start.by, scripts: ok } : null,
      file: file.error ? { error: file.error } : { scripts: file.scripts, ...(text !== null && { hash: hashOf(text) }) },
      pending: Boolean(file.error) || JSON.stringify(file.scripts) !== JSON.stringify(ok),
      // S20: allowed is the user's switch (no tool changes it). running: additional scripts that run now. waiting: rows that do not run yet.
      additional: { allowed: chat.allowScripts(), running: st.additional, waiting: st.waiting },
      library: library(),
      log: logLines(sprint),
      note: 'The scripts approved at Start run, and the additional.running ones. A row in additional.waiting does not run: request_sprint_scripts asks the user to approve the waiting rows (one question for all), or the user approves them in the Sprint scripts window, or starts the sprint again. With additional.allowed true a row added after Start runs with no question. No tool approves a script or changes that switch.',
    };
  }

  // Sprint View and sprint_status: one answer for the page and the tool, so both show the same sprint. It is what a
  // script is told (state, above) without the parts that are about one script run, plus the counts the page draws:
  // done (plan items merged, and ticked), running_ms (since Start), each worker's own work, and how many scripts stand. Reads only.
  // items: every plan line, in the plan's order, so the slices line up with phasesOf's counts; a phase counts only the
  // lines that merge (O164 part (3) FIX1: an owner line is in no phase's steps, the same set as done.total).
  function phasesView(plan, items) {
    const heads = phasesOf(plan), loose = items.length - heads.reduce((n, p) => n + p.items, 0); // items above the first heading
    let at = loose;
    const phases = heads.map((p) => { const mine = items.slice(at, at += p.items).filter((i) => i.role !== 'owner');
      return { title: p.title, merged: mine.filter((i) => i.review?.merged === true).length, total: mine.length }; });
    const current = phases.findIndex((p) => p.merged < p.total);
    return { phases, phase_now: current < 0 ? null : current };
  }
  // A closed sprint answers with its record: this same answer as it was at Close (delegate.mjs, closeSprint), so the
  // closed page's numbers do not move, plus closed { at, by }. An open one has closed null.
  async function view(sprint) {
    const end = chat.projects.closed(sprint);
    if (end?.record) return { ...end.record, closed: { at: iso(end.at), by: end.by } };
    // O164 (done means merged): the one look P9 takes for its own merge evidence before answering. What it proves is
    // recorded on the review record, so the count stays between looks. Best effort: offline, the record stands as it is.
    const repo = await chat.mergedNow?.(sprint).catch(() => undefined);
    const { contract, point, blocking, script, subject, phase, pr, ...s } = await state(sprint, 'status');
    const st = standing(sprint), start = chat.projects.started(sprint);
    // O164 part (3): a v line (Role: owner) never merges — it closes on the owner's click — so it is counted nowhere a
    // merge is counted: not in done.total, not in a phase's steps. It belongs to the owner's own queue and ring (owner).
    const mine = s.items.filter((i) => i.role !== 'owner'), owned = s.items.filter((i) => i.role === 'owner'),
      clicked = new Set(Object.keys(chat.sprint?.(sprint)?.ownerDone ?? {})),
      merged = mine.filter((i) => i.review?.merged === true).length, ms = start && Number.isFinite(start.at) ? Math.max(0, Date.now() - start.at) : null;
    return { ...s, closed: null,
      // merged: by P9's own record of the merge (mergedNow); ticked: the box in the plan, a model's say-so, counted but never done.
      // unproven: reviewed items P9 cannot prove merged because it holds no clone or copy of the repo — the 0 is a fact, not silence.
      done: { merged, ticked: s.items.filter((i) => i.ticked).length,
        unproven: repo === null ? mine.filter((i) => i.review?.commit && i.review?.merged !== true).length : 0, total: mine.length },
      // The owner's own (Role: owner lines): closed by P9's record of the owner's click (ownerDone on the lead's state),
      // never by the plan's tick, never by a merge. An empty queue answers { done: 0, total: 0, items: [] }.
      owner: { done: owned.filter((i) => clicked.has(i.id)).length, total: owned.length,
        items: owned.map((i) => ({ id: i.id, text: i.text, ticked: i.ticked, done: clicked.has(i.id) })) },
      running_ms: ms,
      // H2: the owner's standing-merge switch. true: the lead may merge what passed review; false: merge is the owner's.
      standing_merge: chat.projects.merge(sprint),
      // O162: PRs an hour, the items merged per hour since Start (perHour); null before Start.
      prs_per_hour: ms === null ? null : perHour(merged, ms),
      spent: spentOf(s.workers),
      // phases (I1): each "## Phase" heading of the plan with its items merged and its total; current: the first
      // with an item not merged (null once all have merged). [] for a plan with no such heading: the page shows no phase line.
      ...phasesView(chat.sprintFiles.read(sprint, 'sprint.md'), s.items),
      // work: the items of the plan with this chat's role key. The lead has no queue of its own (chat.queue is a started chat's), so its items are counted here the same way.
      // next (Work Queue row): the first item not passed, the one ready reports (delegate.mjs ready, chat-view itemLine): a merge
      // without a pass (mergedNow records any review commit that landed) leaves it next. null when every item passed.
      workers: s.workers.map((w) => { const q = chat.queue?.(w.chat), own = q ? [] : mine.filter((i) => i.role && i.role === w.key);
        const rows = q ? q.items ?? [] : own.map((i) => ({ text: i.text, state: i.review?.state, merged: i.review?.merged === true })), next = rows.find((r) => r.state !== 'passed')?.text ?? null;
        return { ...w, work: q ? { done: q.done, total: q.total, next } : own.length ? { done: own.filter((i) => i.review?.merged === true).length, total: own.length, next } : null }; }),
      scripts: { running: st.running.length, additional: st.additional.length, waiting: st.waiting.length } };
  }
  async function status(caller, named) { const { sprint, ...no } = where(caller, named); return no.error ? no : view(sprint); }

  // The library and the tools (sprint spec S18; SECURITY.md § Sprint scripts, "The library"). The library is one list per
  // user in P9's database, usable in any sprint of any project. It is only text: nothing in it runs. A script reaches a
  // sprint as a copy in that sprint's hooks.json, and runs only after the owner's Start approves it, so a later change
  // to the library changes no sprint.
  const library = () => { const kept = parse(JSON.stringify({ scripts: chat.scriptLibrary() }), 'The library', MAX_LIBRARY); return kept.error ? [] : kept.scripts; };
  const upsert = (rows, row) => (rows.some((r) => r.name === row.name) ? rows.map((r) => (r.name === row.name ? row : r)) : [...rows, row]);
  const without = (rows, name) => (rows.some((r) => r.name === name) ? rows.filter((r) => r.name !== name) : { error: 'unknown-script', name });
  function libraryWrite(change) {
    const rows = change(library());
    if (rows.error) return rows;
    const next = parse(JSON.stringify({ scripts: rows }), 'The library', MAX_LIBRARY);
    if (next.error) return { error: 'scripts-refused', detail: next.error };
    chat.setScriptLibrary(next.scripts);
    return { library: next.scripts };
  }
  // hooks.json through the guarded save: a file changed since it was read here is not replaced.
  // by: who wrote it, kept for Sprint Setup's "Written by" mark (H2): the calling chat's agent, or the user (owner routes).
  function fileWrite(sprint, change, by) {
    const text = chat.sprintFiles.read(sprint, 'hooks.json'), file = parse(text);
    if (file.error) return { error: 'scripts-refused', detail: file.error + ' Fix hooks.json first.' };
    const rows = change(file.scripts);
    if (rows.error) return rows;
    const next = parse(JSON.stringify({ scripts: rows }));
    if (next.error) return { error: 'scripts-refused', detail: next.error };
    const body = JSON.stringify({ scripts: next.scripts }, null, 2) + '\n';
    let saved; try { saved = chat.sprintFiles.write(sprint, 'hooks.json', body, text === null ? '' : hashOf(text)); } catch { saved = false; }
    if (saved !== true) return saved === 'changed' ? { error: 'sprint-file-changed', detail: 'hooks.json changed meanwhile. Read sprint_scripts and try again.' } : { error: 'not-saved' };
    chat.wrote(sprint, 'hooks.json', body, by);
    return { sprint, file: { scripts: next.scripts, hash: hashOf(body) }, pending: JSON.stringify(next.scripts) !== JSON.stringify(approved(sprint)),
      note: 'In hooks.json. Before Start, Start approves it. In a started sprint it waits (sprint_scripts: additional.waiting; request_sprint_scripts asks the user) unless the user allows additional scripts.' };
  }
  const rowOf = (a) => ({ name: a.name, command: a.command, point: a.point, ...(a.blocking !== undefined && { blocking: a.blocking }), ...(a.every !== undefined && { every: a.every }) });
  const locked = (caller) => (chat.lock(caller).on ? { error: 'agent-lock-on' } : null);
  // sprint_script_save: one script, made or replaced by name, in the sprint's hooks.json or (library: true) the library.
  function save(caller, args) {
    const no = locked(caller); if (no) return no;
    if (args.library === true) return args.sprint === undefined ? libraryWrite((rows) => upsert(rows, rowOf(args))) : { error: 'request-refused', detail: 'library or sprint, not both.' };
    const at = where(caller, args.sprint);
    return at.error ? at : fileWrite(at.sprint, (rows) => upsert(rows, rowOf(args)), chat.agentOf(caller));
  }
  function remove(caller, args) {
    const no = locked(caller); if (no) return no;
    if (args.library === true) return args.sprint === undefined ? libraryWrite((rows) => without(rows, args.name)) : { error: 'request-refused', detail: 'library or sprint, not both.' };
    const at = where(caller, args.sprint);
    return at.error ? at : fileWrite(at.sprint, (rows) => without(rows, args.name), chat.agentOf(caller));
  }
  // sprint_script_add: a copy of one library script into the sprint's hooks.json (a script of that name there is replaced).
  function add(caller, args) {
    const no = locked(caller); if (no) return no;
    const at = where(caller, args.sprint), row = library().find((r) => r.name === args.name);
    if (at.error) return at;
    if (!row) return { error: 'unknown-script', name: args.name, detail: 'No script of that name in the library (sprint_scripts lists it).' };
    return fileWrite(at.sprint, (rows) => upsert(rows, row), chat.agentOf(caller));
  }

  // Which script may be run on request: one the owner approved at Start, by name, and that copy. The one place that
  // decides it (S20 puts the owner's "Allow additional scripts" switch here).
  function runnable(sprint, name) {
    if (chat.projects.closed(sprint)) return { error: 'sprint-closed', detail: 'This sprint is closed: its scripts are off.' };
    const found = standing(sprint).running.find((s) => s.name === name);
    if (found) return found;
    const inFile = parse(chat.sprintFiles.read(sprint, 'hooks.json')).scripts?.some((s) => s.name === name), inLibrary = library().some((s) => s.name === name);
    return { error: 'script-not-approved', name, detail: inFile ? `"${name}" is in hooks.json and the user has not approved it: ${chat.projects.started(sprint) ? 'request_sprint_scripts asks them' : 'it runs after the user starts the sprint'}.`
      : inLibrary ? `"${name}" is only in the library. Add it to the sprint (sprint_script_add) first.` : `This sprint has no approved script named "${name}".` };
  }
  // One approved script, now, waited for. Its input is the same state, with subject { manual: true, by } (by: 'owner' or
  // the asking chat). It refuses nothing: its result is returned and logged. still: asked after the state is gathered
  // (which waits), right before the start; what it answers is returned instead and nothing runs.
  async function runNow(sprint, script, by, still) {
    let base; try { base = await state(sprint, script.point, { manual: true, by }); } catch { base = { contract: 1, point: script.point, error: 'state-unavailable' }; }
    const no = still?.(); if (no) return no;
    const r = await speaking(sprint, script.name, (say) => run(script.command, JSON.stringify({ ...base, blocking: false, script: { name: script.name } }), { cwd: chat.sprintFiles.folderOf(sprint), timeout: TIMEOUT.blocking, say }), script.notify);
    record(sprint, { ...script, point: script.point + ' (run now)' }, r);
    return { sprint, script: script.name, point: script.point, exit: r.exit, reason: r.reason, ms: r.ms, line: r.line };
  }
  // run_sprint_script: the user is asked first, shown the whole command; what runs is the copy that was shown.
  async function runAsked(caller, args, signal) {
    const no = locked(caller); if (no) return no;
    const at = where(caller, args.sprint);
    if (at.error) return at;
    const script = runnable(at.sprint, args.name);
    if (script.error) return script;
    if (!await allowed(caller, { toolCallId: 'p9-mcp-' + randomUUID(), title: 'P9 sprint script: run now, as you, outside every agent\'s mode: ' + said(script), kind: 'execute' }, signal)) return { error: 'not-allowed', detail: 'The user did not allow it.' };
    // Checked after the yes and again right before the start: a cancel, the lock or a new Start in between runs nothing.
    const still = () => {
      if (signal?.aborted) return { error: 'cancelled' };
      const late = locked(caller); if (late) return late;
      const now = runnable(at.sprint, args.name);
      if (now.error === 'sprint-closed') return now;
      return now.error || JSON.stringify(now) !== JSON.stringify(script) ? { error: 'scripts-changed', detail: 'The approved scripts changed while the user was asked. Read sprint_scripts and ask again.' } : null;
    };
    return still() ?? runNow(at.sprint, script, caller, still);
  }
  // Approves rows added after Start: they join the start record as extra, the exact rows, replacing an earlier one of the name.
  function approveRows(sprint, rows) {
    const extra = [...extras(sprint).filter((e) => !rows.some((r) => r.name === e.name)), ...rows];
    if (extra.length > MAX_SCRIPTS * 2) return { error: 'too-many-scripts', detail: `At most ${MAX_SCRIPTS * 2} scripts approved after Start. Start the sprint again to approve the file as it is.` };
    chat.projects.recordStart(sprint, { ...chat.projects.started(sprint), extra });
    return { sprint, approved: rows, additional: { allowed: chat.allowScripts(), running: standing(sprint).additional, waiting: standing(sprint).waiting } };
  }
  // request_sprint_scripts: one question for every waiting row, each shown whole, asked in every mode (Unrestricted
  // too: this switch is the owner's control here, as Start's question is). Read again after the yes.
  async function request(caller, args, signal) {
    const no = locked(caller); if (no) return no;
    const at = where(caller, args.sprint);
    if (at.error) return at;
    if (!chat.projects.started(at.sprint)) return { error: 'sprint-not-started', detail: 'Nothing is approved before Start: the user\'s Start approves every script in hooks.json.' };
    const before = standing(at.sprint).waiting;
    if (!before.length) return { sprint: at.sprint, approved: [], detail: chat.allowScripts() ? 'No script waits: Allow additional scripts is on, so hooks.json runs as it is.' : 'No script waits.' };
    const title = `P9 sprint scripts: approve ${before.length === 1 ? 'this script' : 'these ' + before.length + ' scripts'}, added after Start, to run as you at ${before.length === 1 ? 'its point' : 'their points'}, outside every agent's mode: ` + before.map(said).join(' | ');
    if (!await chat.approve(caller, { toolCallId: 'p9-mcp-' + randomUUID(), title, kind: 'execute' }, signal)) return { error: 'not-allowed', detail: 'The user did not allow it.' };
    if (signal?.aborted) return { error: 'cancelled' };
    const late = locked(caller); if (late) return late;
    if (!same(standing(at.sprint).waiting, before)) return { error: 'scripts-changed', detail: 'The waiting scripts changed while the user was asked. Read sprint_scripts and ask again.' };
    return approveRows(at.sprint, before);
  }

  // The owner's own (the project page, desktop only): the library, and a run of one approved script.
  // sprint named: that sprint's hooks.json (checked and saved as the tools do); left out: the library.
  const known = (sprint) => ID.test(sprint ?? '') && chat.sprintFiles.exists(sprint);
  const owner = {
    // Sprint View's numbers: the same answer sprint_status gives an agent.
    status: async (sprint) => (known(sprint) ? view(sprint) : { error: 'unknown-sprint' }),
    // sprint named and known: also what stands there (the window's Approve needs the waiting rows and the file's hash).
    library(sprint) {
      // One read: the hash the window sends back with Approve is of the rows it is shown here.
      const text = known(sprint) ? chat.sprintFiles.read(sprint, 'hooks.json') : null, st = known(sprint) ? standing(sprint, text) : null;
      return { library: library(), points: POINTS, blocking: BLOCKING, allowed: chat.allowScripts(), ...(st && { additional: st.additional, waiting: st.waiting, hash: text === null ? '' : hashOf(text) }) };
    },
    // The switch: the owner's alone. One setting for every sprint.
    allow(on) { if (typeof on !== 'boolean') return { error: 'request-refused' }; chat.setAllowScripts(on); return { allowed: chat.allowScripts() }; },
    // Approve on a row (names) or Approve all (no names). hash: of the hooks.json the window showed.
    approve(sprint, hash, names) {
      if (!known(sprint)) return { error: 'unknown-sprint' };
      if (!chat.projects.started(sprint)) return { error: 'sprint-not-started' };
      const text = chat.sprintFiles.read(sprint, 'hooks.json');
      if (typeof hash !== 'string' || (text === null ? '' : hashOf(text)) !== hash) return { error: 'scripts-changed', detail: 'hooks.json changed since it was shown. Look again.' };
      // The rows approved are those of the text whose hash was just checked: the file is not read again, so a row
      // written between two reads can never be approved unseen.
      const rows = standing(sprint, text).waiting.filter((r) => !names || names.includes(r.name));
      return rows.length ? approveRows(sprint, rows) : { sprint, approved: [] };
    },
    save: (row, sprint) => (sprint === undefined ? libraryWrite((rows) => upsert(rows, row)) : !known(sprint) ? { error: 'unknown-sprint' } : fileWrite(sprint, (rows) => upsert(rows, row), 'the user')),
    remove: (name, sprint) => (sprint === undefined ? libraryWrite((rows) => without(rows, name)) : !known(sprint) ? { error: 'unknown-sprint' } : fileWrite(sprint, (rows) => without(rows, name), 'the user')),
    add(name, sprint) {
      const row = library().find((r) => r.name === name);
      return !known(sprint) ? { error: 'unknown-sprint' } : !row ? { error: 'unknown-script', name } : fileWrite(sprint, (rows) => upsert(rows, row), 'the user');
    },
    run(sprint, name) {
      if (!known(sprint)) return { error: 'unknown-sprint' };
      const script = runnable(sprint, name);
      // Asked again after the state is gathered (it waits): a Close or a changed script meanwhile runs nothing.
      const still = () => { const now = runnable(sprint, name); return now.error ? now : JSON.stringify(now) !== JSON.stringify(script) ? { error: 'scripts-changed', detail: 'The approved scripts changed. Press Run now again.' } : null; };
      return script.error ? script : runNow(sprint, script, 'owner', still);
    },
  };
  return { fire, ordered, event, read, status, view, standing, approved, save, remove, add, run: runAsked, request, owner, where, say, tick, stop };
}
