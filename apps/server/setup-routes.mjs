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
  // "Create my starter files" (Builder, 2026-10-22: "1 yes"; threat model row 17): create-only, so an existing file or
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
  // Builder, 2026-11-02: the slim Temporary P9 installs without the agents' binary packages (about 600 MB); the desktop asks for
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
      done = await new Promise((resolve) => execFile(process.execPath, [script, ...names], { timeout: outer.AGENTS_FETCH_MS, maxBuffer: 1024 * 1024 },
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
    if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'max,start,workers' || !['off', 'ask', 'agent'].includes(body.start)
        || !Number.isInteger(body.max) || body.max < 1 || body.max > 20 || !Array.isArray(body.workers) || body.workers.length > 20 || !body.workers.every(one)) return c.json({ error: 'request-refused' }, 400);
    return c.json(outer.chat.setDelegation(body));
  });
  return { signedIn };
}
