// The setup wizard's routes (/setup*, /terminal-greeting) on the desktop app and api. Split out of server.mjs's createListener (F9) with no change in behaviour; names that stay in createListener come in through outer.
import { parseSettings, createMission } from './mission.mjs';
import path from 'node:path';
import { agentDirs } from './limits.mjs';
import os from 'node:os';
import { readdir, access, stat, mkdir, open } from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import { found as onPath, wizardDependencies, placeAgents, AGENTS, adminCommand } from './deps.mjs';
import { createDirectory, createFile } from '../../packages/files/index.mjs';
import { SETTINGS } from './mission-fields.mjs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { childEnv, FETCH_NAMES } from './child-env.mjs';

export function setupRoutes(outer) {
  // The wizard's own paths, checked as settings.json would be: only the four keys, each workspace-relative.
  const wizardPaths = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).every((key) => outer.WIZARD_KEYS.includes(key))) return null;
    try { return parseSettings(JSON.stringify(input)); } catch { return null; }
  };
  // Settings are per machine, not per workspace: after "Change workspace" they can name starter paths this folder lacks while
  // the folder has its own layout. What it has that the settings do not name; non-empty means Create must not lay a starter.
  // Settings that name none of Mission's three files (the first-run {}): the wizard finds and offers what is there, as with none.
  const names = (loaded) => ['primary', 'registry', 'waiting'].some((key) => loaded?.[key] !== undefined);
  const differing = async (loaded, empty) => {
    if (!names(loaded)) return empty ? {} : outer.existing();
    if (empty || !(await outer.planFor(loaded, false)).length) return {};
    const own = await outer.existing();
    return Object.fromEntries(Object.entries(own).filter(([key, value]) => loaded[key] !== value));
  };
  // Whether each agent is signed in: its credentials file exists (never read).
  const signedIn = async () => ({ claude: await outer.present(path.join(agentDirs(os.homedir()).claudeDir, '.credentials.json')),
    codex: await outer.present(path.join(agentDirs(os.homedir()).codexHome, 'auth.json')) });
  outer.app.get('/setup', async (c) => {
    const disk = await outer.settingsOnDisk(), empty = !(await readdir(outer.workspace)).length;
    // A settings file (loaded or on disk) decides the paths. Without one: an empty folder gets the starter paths, any other
    // gets what it already has, filled in with the starter paths, which the wizard shows and lets the owner change.
    const loaded = outer.settings ?? disk.parsed;
    const found = (outer.settings || disk.text !== undefined || empty) && !loaded ? {} : await differing(loaded, empty);
    const query = c.req.query(), asked = Object.keys(query).length ? wizardPaths(query) : null;
    const proposed = loaded && (Object.keys(found).length || !names(loaded)) ? asked ?? { ...loaded, ...found } : outer.settings ?? disk.parsed ?? asked ?? { ...outer.STARTER_SETTINGS, ...found };
    const paths = outer.settings ?? disk.parsed ?? outer.STARTER_SETTINGS;
    return c.json({ workspace: outer.workspace, settingsFile: outer.settingsFile ?? null, settings: Boolean(outer.settings), settingsPresent: disk.text !== undefined,
      settingsInvalid: Boolean(disk.error), settingsError: disk.error ?? null,
      writable: await access(outer.workspace, fsConstants.W_OK).then(() => true, () => false), workspaceEmpty: empty,
      found, conflict: Boolean(loaded && Object.keys(found).length), proposed,
      creates: disk.error ? [] : await outer.planFor(proposed, empty), ...(Object.keys(query).length && !asked ? { pathsInvalid: true } : {}),
      // null: settings.json leaves that key out (all three are optional).
      agentsFile: paths.primary === undefined ? null : await stat(path.join(outer.workspace, paths.primary)).then(() => true, () => false), // a file or a folder
      registryFile: paths.registry === undefined ? null : await outer.present(path.join(outer.workspace, paths.registry)),
      // null off Linux: only the tmux backend has a socket, and only it needs a binary installed.
      tmux: outer.terminals.socket ? await outer.terminals.list().then(() => true, (error) => error.message !== 'tmux-not-found') : null,
      ...await signedIn(),
      // D8: each agent's own CLI, for a terminal and Hand off (chats use the CLI the adapter ships, so they work without it).
      claudeCli: await onPath('claude'), codexCli: await onPath('codex'),
      // Item 15: every dependency, its reason and, for a system package, the admin command (deps.mjs).
      dependencies: await wizardDependencies() });
  });
  // "Create my starter files" (threat model row 17): create-only, so an existing file or
  // folder counts as done and is never replaced. An invalid settings file is never touched; the wizard shows its error.
  // The new settings load live: with no settings every Mission route answered 503, so no run exists to lose here.
  // The body is {} (the settings file's paths, or the starter paths in an empty folder) or the wizard's chosen paths, which
  // a folder with things in it always needs: the fixed starter paths never land there unshown.
  outer.app.post('/setup/starter', async (c) => {
    const body = await outer.json(c);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'request-refused' }, 400);
    const chosen = Object.keys(body).length ? wizardPaths(body) : null;
    if (Object.keys(body).length && !chosen) return c.json({ error: 'request-refused' }, 400);
    if (!outer.settingsFile) return c.json({ error: 'settings-file-unknown' }, 409);
    const disk = await outer.settingsOnDisk();
    if (disk.error) return c.json({ error: 'settings-invalid', detail: disk.error }, 409);
    const old = disk.parsed ?? outer.settings, empty = !(await readdir(outer.workspace)).length;
    // Settings are replaced only when the owner confirms other paths for a folder whose own layout they do not name.
    const repoint = Boolean(chosen && old);
    if (repoint && names(old) && !Object.keys(await differing(old, empty)).length) return c.json({ error: 'settings-exist' }, 409);
    if (!chosen && !outer.settings && disk.text === undefined && !empty) return c.json({ error: 'paths-required' }, 409);
    // The wizard's keys are the chosen ones; every other key of the old file (space, notes_roots, server_host ...) carries over.
    const paths = repoint ? parseSettings(JSON.stringify({ ...Object.fromEntries(Object.entries(old).filter(([key]) => !outer.WIZARD_KEYS.includes(key))), ...chosen }))
      : outer.settings ?? disk.parsed ?? chosen ?? outer.STARTER_SETTINGS;
    // The settings name starter paths this folder lacks, and it has its own: nothing is laid beside them unshown.
    if (!repoint && (outer.settings || disk.parsed) && Object.keys(await differing(paths, empty)).length) return c.json({ error: 'layout-differs' }, 409);
    const made = (promise) => promise.then(() => true, (error) => { if (error.code === 'EEXIST') return false; throw error; });
    const folders = async (relative) => { for (let i = 1; i < relative.length; i++) await made(createDirectory(outer.workspace, relative.slice(0, i).join('/'))); };
    const created = [], plan = await outer.planFor(paths, empty);
    // BL1: a file where a planned folder goes (waiting named a file) failed mid-create as ENOTDIR, a 400 request-refused.
    // Checked before anything is made, so nothing is half laid.
    for (const relative of plan) {
      const parts = relative.replace(/\/$/, '').split('/');
      for (let i = 1; i < parts.length; i++) {
        const segment = parts.slice(0, i).join('/');
        if (await stat(path.join(outer.workspace, segment)).then((s) => !s.isDirectory(), () => false)) return c.json({ error: 'path-is-a-file', detail: segment }, 409);
      }
    }
    for (const [relative, content] of [[paths.primary, outer.STARTER_AGENTS], [paths.registry, '{"scripts":[],"apps":[],"pages":[]}\n'], [paths.waiting + '/AGENTS.md', outer.STARTER_WAITING]]) {
      if (!plan.includes(relative)) continue;
      await folders(relative.split('/'));
      if (await made(createFile(outer.workspace, relative, content))) created.push(relative);
    }
    if (plan.includes('_ideas/') && await made(createDirectory(outer.workspace, '_ideas'))) created.push('_ideas/');
    if (repoint) {
      await outer.replaceSettings(disk.text, paths);
      created.push(outer.settingsFile);
    } else if (disk.text === undefined) {
      await mkdir(path.dirname(outer.settingsFile), { recursive: true, mode: 0o700 });
      const file = await open(outer.settingsFile, 'wx', 0o600).catch((error) => { if (error.code === 'EEXIST') return null; throw error; });
      if (!file) return c.json({ error: 'settings-changed' }, 409); // written by someone else meanwhile: Retry re-reads it
      try { await file.writeFile(JSON.stringify(paths, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
      created.push(outer.settingsFile);
    }
    if (!outer.settings) {
      outer.settings = disk.parsed ?? paths;
      outer.settingsInvalid = false;
      outer.server.mission = outer.mission = createMission({ workspace: outer.workspace, recovery: outer.recovery, settings: outer.settings, instance: outer.instance, lifecycle: outer.lifecycle, allowed: outer.allowed, drafts: outer.drafts, loose: outer.loose });
    }
    return c.json({ created, settings: true }, 201);
  });
  // ST1/ST2: Settings → Mission Control files edits the loaded settings.json; the phone too since c18 (row 66), unlike the rest of /setup. The body
  // names only settings.json keys (null removes one); the result is checked by parseSettings, the same rules as at start, so
  // this route has none of its own. Notes folders keep their read-time refusals (home, workspace, recovery).
  // ponytail: read-change-write with no lock; the one caller saves one row at a time.
  outer.api.get('/setup/settings', async (c) => {
    const disk = await outer.settingsOnDisk();
    // remoteOrigin: this daemon's own phone address (--remote-origin), for "Continue on phone"; absent with remote logins off.
    return c.json({ settings: disk.parsed ?? null, error: disk.error ?? null, ...(outer.remote && !c.get('device') ? { remoteOrigin: outer.remote.origin } : {}) });
  });
  outer.api.post('/setup/settings', async (c) => {
    const body = await outer.json(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || !Object.keys(body).every((key) => Object.hasOwn(SETTINGS, key))) return c.json({ error: 'request-refused' }, 400);
    if (!outer.settingsFile) return c.json({ error: 'settings-file-unknown' }, 409);
    // One save at a time: each reads the file the one before it wrote, so quick saves of different keys all land.
    const turn = outer.settingsSaves.then(async () => {
      await outer.reloadSettings();
      const disk = await outer.settingsOnDisk();
      if (disk.error) return c.json({ error: 'settings-invalid', detail: disk.error }, 409);
      if (!disk.parsed || !outer.settings) return c.json({ error: 'settings-missing' }, 409);
      const next = { ...disk.parsed };
      for (const [key, value] of Object.entries(body)) { if (value === null) delete next[key]; else next[key] = value; }
      let parsed;
      try { parsed = parseSettings(JSON.stringify(next)); } catch (error) { return c.json({ error: 'settings-refused', detail: error.detail ?? error.message }, 400); }
      await outer.replaceSettings(disk.text, parsed);
      return c.json({ settings: parsed });
    });
    outer.settingsSaves = turn.then(() => {}, () => {});
    return turn;
  });
  // Wizard sign-in (threat model row 31), desktop only: main is the only caller, and opens the URL only after its origin check.
  outer.app.get('/setup/login', (c) => outer.reply(c, outer.chat.login.state()));
  outer.app.post('/setup/login', async (c) => outer.reply(c, await outer.chat.login.start(await outer.json(c))));
  outer.app.post('/setup/login/code', async (c) => outer.reply(c, outer.chat.login.code(await outer.json(c))));
  outer.app.post('/setup/login/stop', async (c) => outer.reply(c, await outer.chat.login.stop(await outer.json(c))));
  // D7/D8 (threat model row 53): an agent's official install or sign-in command, typed into a new P9 terminal and never run:
  // the owner reads it and presses Enter, and the terminal shows its output. The command comes from this table only; the
  // credentials the CLI saves stay in its own folder and never pass through P9.
  outer.app.post('/setup/agent-terminal', async (c) => {
    const body = await outer.json(c);
    if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'action,agent' || typeof body.agent !== 'string' || typeof body.action !== 'string'
        || !Object.hasOwn(outer.AGENT_COMMANDS, body.agent) || !Object.hasOwn(outer.AGENT_COMMANDS[body.agent], body.action)) return outer.reply(c, { status: 400, error: 'request-refused' });
    const command = outer.AGENT_COMMANDS[body.agent][body.action];
    const made = await outer.terminals.create({}, { cwd: outer.workspace, typed: command });
    return outer.reply(c, made.terminal ? { status: 201, terminal: made.terminal, command } : { ...made, command });
  });
  // Item 15: the wizard's Install for the agents the owner picked, {claude, codex} as booleans: a launcher in P9's bin folder
  // for each true one, pointing at the CLI P9 ships. Nothing is downloaded and nothing needs the admin password.
  outer.app.post('/setup/agents', async (c) => {
    const body = await outer.json(c);
    if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'claude,codex' || typeof body.claude !== 'boolean' || typeof body.codex !== 'boolean'
        || !(body.claude || body.codex)) return outer.reply(c, { status: 400, error: 'request-refused' });
    try { return outer.reply(c, { status: 200, installed: await placeAgents(AGENTS.filter((agent) => body[agent])) }); }
    catch (error) { return outer.reply(c, { status: 500, error: 'agents-not-installed', detail: error.code ?? error.message }); }
  });
  // The slim Temporary P9 installs without the agents' binary packages (about 600 MB); the desktop asks for
  // the ones the owner picked once it is connected, and this fetches them (scripts/agents.mjs: pinned versions, checked against
  // their sha512, an agent already there skipped). Only a folder with agents.json (a daemon bundle) fetches; a checkout says so.
  outer.app.post('/setup/agents-fetch', async (c) => {
    const body = await outer.json(c);
    if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'claude,codex' || typeof body.claude !== 'boolean' || typeof body.codex !== 'boolean'
        || !(body.claude || body.codex)) return outer.reply(c, { status: 400, error: 'request-refused' });
    const script = fileURLToPath(new URL('../../scripts/agents.mjs', import.meta.url));
    if (!existsSync(fileURLToPath(new URL('../../agents.json', import.meta.url)))) return outer.reply(c, { status: 409, error: 'not-a-bundle' });
    const names = AGENTS.filter((agent) => body[agent]);
    if (outer.agentsFetching) return outer.reply(c, { status: 409, error: 'fetch-running' });
    outer.agentsFetching = true;
    let done;
    try {
      done = await new Promise((resolve) => execFile(process.execPath, [script, ...names], { timeout: outer.AGENTS_FETCH_MS, maxBuffer: 1024 * 1024, env: childEnv(process.env, process.platform, FETCH_NAMES) },
        (error, stdout, stderr) => resolve(error ? (String(stderr).trim().split('\n').pop() || error.message) : null)));
    } finally { outer.agentsFetching = false; }
    return outer.reply(c, done ? { status: 500, error: 'agents-not-fetched', detail: done.slice(0, 300) } : { status: 200, fetched: names });
  });
  // Item 15 (threat model row 61): a system package P9 cannot carry, installed with the admin password. The command comes
  // from deps.mjs's table for a dependency that is missing now, typed into a new P9 terminal and never run: the owner reads
  // the reason first (the wizard's screen), then the command, and presses Enter; sudo asks for the password there.
  outer.app.post('/setup/admin-terminal', async (c) => {
    const body = await outer.json(c);
    if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'id' || typeof body.id !== 'string') return outer.reply(c, { status: 400, error: 'request-refused' });
    const command = await adminCommand(body.id);
    if (!command) return outer.reply(c, { status: 409, error: 'nothing-to-install' });
    const made = await outer.terminals.create({}, { cwd: outer.workspace, typed: command });
    return outer.reply(c, made.terminal ? { status: 201, terminal: made.terminal, command } : { ...made, command });
  });
  // Desktop only: { show: boolean }, for terminals made from then on (a running shell keeps what it printed).
  outer.app.get('/terminal-greeting', (c) => c.json({ show: outer.greeting() }));
  outer.app.post('/terminal-greeting', async (c) => {
    const body = await outer.json(c);
    if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'show' || typeof body.show !== 'boolean') return c.json({ error: 'request-refused' }, 400);
    outer.ledger.db.prepare("INSERT INTO prefs (key, value) VALUES ('terminal-greeting', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(body.show ? 'on' : 'off');
    return c.json({ show: outer.greeting() });
  });
  // Desktop only, Settings > Delegation: who starts a sprint, how many workers a chat may run, and what each one runs on.
  outer.app.get('/delegation', (c) => c.json(outer.chat.delegation()));
  outer.app.post('/delegation', async (c) => {
    const body = await outer.json(c), str = (x) => typeof x === 'string' && x.length <= 200;
    const one = (x) => x && typeof x === 'object' && Object.keys(x).sort().join() === 'agent,effort,model' && str(x.model) && str(x.effort)
      && (['', 'claude', 'codex'].includes(x.agent) || (typeof x.agent === 'string' && /^profile:[\w-]{1,80}$/.test(x.agent)));
    if (!body || typeof body !== 'object' || !['max,start,workers', 'max,setup,start,workers'].includes(Object.keys(body).sort().join()) || (body.setup !== undefined && (typeof body.setup !== 'string' || body.setup.length > 2000)) || !['off', 'ask', 'agent'].includes(body.start)
        || !Number.isInteger(body.max) || body.max < 1 || body.max > 20 || !Array.isArray(body.workers) || body.workers.length > 20 || !body.workers.every(one)) return c.json({ error: 'request-refused' }, 400);
    return c.json(outer.chat.setDelegation(body));
  });
  // Desktop only, Settings > New chats start in (O133): each agent's Default model and Default effort; O137: and Default mode
  // ('' clears it; else one of that agent's own mode names), which a worker started under Unrestricted starts in.
  outer.app.get('/start-defaults', (c) => c.json(outer.chat.newChatDefaults()));
  // Body { set: { <agent>: { model?, effort? } }, onlyEmpty?: true }: only the fields named change (see setNewChatDefaults).
  outer.app.post('/start-defaults', async (c) => {
    const body = await outer.json(c), agents = Object.keys(outer.chat.newChatDefaults()), str = (x) => typeof x === 'string' && x.length <= 200, set = body?.set;
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'set' && k !== 'onlyEmpty') || (body.onlyEmpty !== undefined && body.onlyEmpty !== true)
        || !set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length
        || !Object.entries(set).every(([a, f]) => agents.includes(a) && f && typeof f === 'object' && Object.keys(f).length && Object.entries(f).every(([k, x]) => (k === 'model' || k === 'effort' ? str(x) : k === 'mode' && (x === '' || outer.chat.modeNames?.(a)?.includes(x)))))) return c.json({ error: 'request-refused' }, 400);
    return c.json(outer.chat.setNewChatDefaults(set, body.onlyEmpty === true));
  });
  // Desktop only, Settings > Notices (O197): how each kind of P9 notice reaches a parent chat, 'note' or 'message'.
  outer.app.get('/notices', (c) => c.json(outer.chat.notices()));
  // Body { set: { <kind>: 'note' | 'message' } }: only the kinds named change.
  outer.app.post('/notices', async (c) => {
    const body = await outer.json(c), kinds = Object.keys(outer.chat.notices()), set = body?.set;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'set') || !set || typeof set !== 'object' || Array.isArray(set)
        || !Object.keys(set).length || !Object.entries(set).every(([k, x]) => kinds.includes(k) && (x === 'note' || x === 'message'))) return c.json({ error: 'bad-request' }, 400);
    return c.json(outer.chat.setNotices(set));
  });
  // Desktop only (SECURITY.md § Worker folders, "Who cleans up"): one sprint's worker folders, by the store's own rules
  // (worker-folders.mjs clean). Refused while a worker the lead started is not stopped, and while the lead is in a turn or
  // has a message waiting: it may be making a worker folder, which has nothing of its own yet and would read as merged.
  // Same refusal for apply (SECURITY.md § Sprint from a folder with no remote): nothing runs while a worker or the lead is busy.
  const idle = (id) => {
    const lead = outer.chat.info(id);
    const running = outer.chat.family().filter((x) => x.parent === id && !['stopped', 'moved'].includes(x.state)).map((x) => x.title || x.id);
    if (running.length || lead?.state === 'turn' || lead?.busy) {
      return { error: 'sprint-running', running, detail: running.length ? 'Stop its workers first: ' + running.join(', ') + '.' : 'Its lead is working; wait for its turn to end.' };
    }
    return null;
  };
  outer.app.post('/sprints/:id/clean', async (c) => {
    const id = c.req.param('id'), busy = idle(id);
    if (busy) return c.json(busy, 409);
    const result = await outer.chat.workers.clean(id);
    return c.json(result, result.error === 'request-refused' ? 400 : result.error ? 500 : 200);
  });
  // Desktop only (SECURITY.md § Sprint from a folder with no remote, "Applying to your folder is a yes"): the change the
  // owner is shown, then the owner's yes for exactly that change. Not on the phone routes, and no agent tool calls these.
  outer.app.get('/sprints/:id/apply', async (c) => c.json(await outer.chat.workers.preview(c.req.param('id'))));
  outer.app.get('/sprints', async (c) => c.json(await outer.chat.workers.copies()));
  outer.app.get('/sprints/:id/close', async (c) => {
    const result = await outer.chat.workers.close(c.req.param('id'));
    return c.json(result, result.error === 'request-refused' ? 400 : result.error === 'not-applied' ? 404 : 200);
  });
  outer.app.post('/sprints/:id/apply', async (c) => {
    const id = c.req.param('id'), body = await outer.json(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== 'shown,yes' || body.yes !== true || typeof body.shown !== 'string') {
      return c.json({ error: 'request-refused' }, 400);
    }
    const busy = idle(id);
    if (busy) return c.json(busy, 409);
    const result = await outer.chat.workers.apply(id, { yes: body.yes, shown: body.shown });
    // A change that landed whose result could not be recorded is not a success: 500, and the close view reads it as unknown.
    const status = result.recordError ? 500 : !result.refused ? 200 : result.refused === 'no-owner-yes' ? 400 : result.refused === 'already-applied' || result.refused === 'changed-since-shown' ? 409 : result.refused === 'no-copy' ? 404 : 422;
    return c.json(result, status);
  });
  // Desktop only (SECURITY.md § Start sprint): a sprint to prepare, and the owner's Start press, which is the approval
  // record of its plan. No phone route and no agent reaches these; an agent's start_sprint asks the user in its chat.
  outer.app.post('/projects/:id/sprints', async (c) => outer.reply(c, await outer.chat.projects.newSprint(c.req.param('id'), await outer.json(c))));
  outer.app.post('/sprints/:id/start', async (c) => {
    const body = await outer.json(c);
    // hooks: the SHA-256 of the hooks.json the page showed (SECURITY.md § Sprint scripts); nothing else is taken.
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'hooks') || (body.hooks !== undefined && !/^[0-9a-f]{64}$/.test(body.hooks))) return c.json({ error: 'request-refused' }, 400);
    const result = await outer.mcp.ownerStart(c.req.param('id'), undefined, body.hooks);
    const status = !result.error ? 200 : result.error === 'unknown-sprint' ? 404 : ['sprint-starting', 'scripts-changed'].includes(result.error) ? 409
      : ['role-refused', 'too-many-roles', 'request-refused', 'delegate-off', 'scripts-refused', 'script-refused'].includes(result.error) ? 400 : 500;
    return c.json(result, status);
  });
  // Desktop only (SECURITY.md § Close sprint): the Sprint View's Close sprint button, the owner's press. An agent's
  // close_sprint asks the user in its chat. No phone route.
  outer.app.post('/sprints/:id/close', async (c) => {
    const body = await outer.json(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return c.json({ error: 'request-refused' }, 400);
    const result = await outer.mcp.ownerClose(c.req.param('id'));
    return c.json(result, !result.error ? 200 : result.error === 'unknown-sprint' ? 404 : ['sprint-closed', 'sprint-not-started', 'sprint-starting'].includes(result.error) ? 409 : ['request-refused', 'script-refused'].includes(result.error) ? 400 : 500);
  });
  // Desktop only (O164 part (3), Role: owner on a v line): the Sprint View's click that closes the owner's own item.
  // No merge is involved and no agent tool does this — it is the owner's own call, recorded by P9.
  outer.app.post('/sprints/:id/owner-done', async (c) => {
    const body = await outer.json(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'item' || typeof body.item !== 'string') return c.json({ error: 'request-refused' }, 400);
    const result = outer.mcp.ownerDone(c.req.param('id'), body.item);
    return c.json(result, !result.error ? 200 : result.error === 'unknown-sprint' ? 404 : ['sprint-not-started', 'sprint-closed'].includes(result.error) ? 409 : result.error === 'not-the-owners' ? 422 : 400);
  });
  // Desktop only (SECURITY.md § Sprint scripts, "The library"): the owner's script library and a run of one approved
  // script. No phone route. An agent has the tools instead (sprint_script_save, _remove, _add, run_sprint_script).
  const scriptStatus = (r) => (!r.error ? 200 : r.error === 'unknown-sprint' || r.error === 'unknown-script' ? 404 : ['script-not-approved', 'sprint-file-changed', 'scripts-changed', 'sprint-not-started', 'too-many-scripts'].includes(r.error) ? 409 : r.error === 'not-saved' ? 500 : 400);
  // Sprint View's numbers, desktop only: the answer the sprint_status tool gives an agent.
  outer.app.get('/sprints/:id/status', async (c) => { const result = await outer.mcp.ownerScripts.status(c.req.param('id')); return c.json(result, scriptStatus(result)); });
  outer.app.get('/sprint-scripts', (c) => c.json(outer.mcp.ownerScripts.library(c.req.query('sprint'))));
  // The owner's switch and Approve (S20, "Scripts added after Start"): desktop only, and no agent tool does either.
  outer.app.post('/sprint-scripts/allow', async (c) => {
    const body = await outer.json(c), result = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).join() === 'on' ? outer.mcp.ownerScripts.allow(body.on) : { error: 'request-refused' };
    return c.json(result, scriptStatus(result));
  });
  outer.app.post('/sprints/:id/approve-scripts', async (c) => {
    const body = await outer.json(c), ok = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((k) => ['hash', 'names'].includes(k))
      && (body.names === undefined || (Array.isArray(body.names) && body.names.length > 0 && body.names.every((n) => typeof n === 'string')));
    const result = ok ? outer.mcp.ownerScripts.approve(c.req.param('id'), body.hash, body.names) : { error: 'request-refused' };
    return c.json(result, scriptStatus(result));
  });
  outer.app.post('/sprint-scripts', async (c) => {
    // One of save (a row), remove (a name) or add (a library name, into a sprint); sprint: that sprint's hooks.json instead of the library.
    const body = await outer.json(c), { sprint, ...rest } = body && typeof body === 'object' && !Array.isArray(body) ? body : {}, keys = Object.keys(rest).join();
    const result = sprint !== undefined && typeof sprint !== 'string' ? { error: 'request-refused' }
      : keys === 'save' && rest.save && typeof rest.save === 'object' && !Array.isArray(rest.save) ? outer.mcp.ownerScripts.save(rest.save, sprint)
      : keys === 'remove' && typeof rest.remove === 'string' ? outer.mcp.ownerScripts.remove(rest.remove, sprint)
      : keys === 'add' && typeof rest.add === 'string' && sprint !== undefined ? outer.mcp.ownerScripts.add(rest.add, sprint) : { error: 'request-refused' };
    return c.json(result, scriptStatus(result));
  });
  outer.app.post('/sprints/:id/run-script', async (c) => {
    const body = await outer.json(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'name' || typeof body.name !== 'string') return c.json({ error: 'request-refused' }, 400);
    const result = await outer.mcp.ownerScripts.run(c.req.param('id'), body.name);
    return c.json(result, scriptStatus(result));
  });
  // Desktop only (SECURITY.md § Pause sprint): the project page's Pause and Resume, the owner's press. No body.
  for (const [verb, call] of [['pause', 'ownerPause'], ['resume', 'ownerResume']]) outer.app.post(`/sprints/:id/${verb}`, async (c) => {
    const body = await outer.json(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return c.json({ error: 'request-refused' }, 400);
    const result = await outer.mcp[call](c.req.param('id'));
    return c.json(result, result.error ? 404 : 200);
  });
  // Desktop only, the project page: a project's sprint source (an address) and its own setup command. Never on the
  // routes the phone reaches, and no agent tool calls it (SECURITY.md § Worker folders).
  // Desktop only (H2): the owner's Seen press on a Setup file an agent wrote. No phone route and no agent tool does it.
  outer.app.post('/sprints/:id/seen', async (c) => outer.reply(c, outer.chat.projects.seen(c.req.param('id'), await outer.json(c))));
  outer.app.post('/projects/:id/sprint-settings', async (c) => outer.reply(c, await outer.chat.projects.setSprintSet(c.req.param('id'), await outer.json(c))));
  return { signedIn };
}
