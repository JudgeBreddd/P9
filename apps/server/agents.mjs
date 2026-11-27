// CAT-1: the agent catalog, one entry per agent P9 can run. The server's per-agent tables are read from here.
// No imports: scripts/deps.mjs (install.sh's check) loads deps.mjs, which reads this, before the daemon's modules are built.
// modes: name -> { value: what the agent is sent, tier: 0 reads only, 1 asks before each action, 2 edits files, 3 acts with
// a reviewer, 4 acts unasked }. start: the mode value a chat starts in; auto: the mode name a sprint worker starts in;
// narrow: the no-write mode value (the agent lock's, and a turn answering another chat's question).
// usage: reader, the limits.mjs reader of its plan limits; poll, the daemon's live poll of them (main.mjs POLLS), if any; staleMs, how old a reading may be before it is marked stale (the
// ledger's own 15 min line); pool, the plan the reading counts against; hideSignedOut, the limits are shown as signed out
// (null) when the sign-in file is missing. Claude's is false: on a Mac its sign-in can live in the keychain, not a file.
// apiPrice (optional): its turns get an API-price estimate from usage-turns.mjs PRICES; without it they show no price.
// acp: the ACP version P9 asks the agent for (chat.mjs ACP_ASK says why each is what it is). tellStart: the start mode P9
// sets on a new or resumed session is shown at once; false, it is set quietly and the window's mode comes with the first
// prompt (Claude's, as its adapter's own start was).
// native: the agent's binary package name before its platform (linux-x64, win32-arm64, ...), as agents.json names it.
// resultCopy (optional): its adapter may send a streamed reply again under the result's uuid (claude-agent-acp's result
// fallback), so chat.mjs also drops a short copy under a uuid (DUP-1); without it only the same-id and 200-character rules apply.
// ladder (optional): its model families, smallest first; a lead told of a worker's third fix is named only the ones above
// the worker's (delegate.mjs thirdFix, O243). Without it, or on a provider profile, the lead is told only "a larger model".
const STALE = 15 * 60 * 1000;
const entry = (agent) => Object.freeze({ ...agent, modes: Object.freeze(agent.modes), usage: Object.freeze(agent.usage), ...(agent.ladder && { ladder: Object.freeze(agent.ladder) }) });
export const CATALOG = Object.freeze([
  entry({ id: 'claude', name: 'Claude Code', adapter: 'claude-agent-acp', native: '@anthropic-ai/claude-agent-sdk-', cliPass: ' --cli',
    login: { args: ['--cli', 'auth', 'login', '--claudeai'], command: 'claude auth login' },
    signIn: { kind: 'browser', dir: 'claudeDir', file: '.credentials.json' },
    modes: { Auto: { value: 'auto', tier: 3 }, Manual: { value: 'default', tier: 1 }, Plan: { value: 'plan', tier: 0 },
      'Accept edits': { value: 'acceptEdits', tier: 2 }, 'Bypass permissions': { value: 'bypassPermissions', tier: 4 } },
    acp: 1, tellStart: false, resultCopy: true, ladder: ['haiku', 'sonnet', 'opus', 'fable'],
    start: 'default', auto: 'Auto', narrow: 'plan', models: 'session', usage: { reader: 'claude-json', poll: 'claude-sdk', staleMs: STALE, pool: 'claude', hideSignedOut: false, apiPrice: true },
    signedOut: 'Claude Code is not signed in on this computer. Sign in from Settings → Setup in the desktop app, or open a terminal, run claude and log in. Then start a new chat.',
    why: 'Claude Code, for Claude chats and a terminal.',
    short: 'Claude', pick: 'Claude Code, by Anthropic. Needs a Claude account (Pro, Max or Team) or an API key.', account: 'A Claude account. After you sign in the browser shows a code: paste it here.' }),
  entry({ id: 'codex', name: 'Codex', adapter: 'codex-acp', native: '@openai/codex-', cliPass: '',
    login: { args: ['cli', 'login', '--device-auth'], command: 'codex login' },
    signIn: { kind: 'device-code', flag: '--device-auth', dir: 'codexHome', file: 'auth.json' },
    modes: { 'Read-only': { value: 'read-only', tier: 0 }, 'Workspace access': { value: 'workspace-write', tier: 2 },
      'Auto review': { value: 'agent', tier: 3 }, 'Full access': { value: 'agent-full-access', tier: 4 } },
    acp: 2, tellStart: true,
    start: 'agent', auto: 'Auto review', narrow: 'read-only', models: 'session', usage: { reader: 'codex-files', poll: 'codex-app', staleMs: STALE, pool: 'codex', hideSignedOut: true },
    signedOut: 'Codex is not signed in on this computer. Sign in from Settings → Setup in the desktop app, or open a terminal and run codex login. Then start a new chat.',
    why: 'Codex, for Codex chats and a terminal.',
    short: 'Codex', pick: 'Codex, by OpenAI. Needs a ChatGPT account (Plus, Pro or Business) or an API key.', account: 'A ChatGPT account. P9 shows a one-time code to enter on OpenAI\'s sign-in page.' }),
]);

const each = (pick) => Object.freeze(Object.fromEntries(CATALOG.map((a) => [a.id, pick(a)])));
// An id is a-z 0-9 - only: the desktop puts it in HTML attributes and drops any other.
export const AGENT_IDS = Object.freeze(CATALOG.map((a) => a.id));
// The tables the server reads, keyed by agent id.
export const MODES = each((a) => Object.freeze(Object.fromEntries(Object.entries(a.modes).map(([name, m]) => [name, m.value]))));
export const TIER = each((a) => Object.freeze(Object.fromEntries(Object.entries(a.modes).sort((x, y) => x[1].tier - y[1].tier).map(([name, m]) => [name, m.tier]))));
export const NARROW = each((a) => a.narrow);
export const START = each((a) => a.start);
export const AUTO = each((a) => a.auto);
export const API_PRICED = each((a) => a.usage.apiPrice === true);
export const LOGIN = each((a) => Object.freeze([...a.login.args]));
export const COMMANDS = each((a) => Object.freeze({ login: a.login.command }));
export const PASS = each((a) => a.cliPass);
export const SIGNED_OUT = each((a) => a.signedOut);
export const WHY = each((a) => a.why);
export const ADAPTER = each((a) => a.adapter);
export const SIGN_IN = each((a) => a.signIn);
// CAT-1b: 'browser', the CLI opens a page and the paste box takes a code; 'device-code', it prints a page and a one-time
// code, listens on no port, and so works when the daemon runs on another computer.
export const SIGN_IN_KIND = each((a) => a.signIn.kind);
// flag: a device-code agent's login argument; a CLI too old for it names the flag when it refuses it (unsupported).
export const SIGN_IN_FLAG = each((a) => a.signIn.flag ?? null);
export const ACP = each((a) => a.acp);
export const TELL_START = each((a) => a.tellStart);
export const RESULT_COPY = each((a) => a.resultCopy === true);
// CAT-1i: the agent a binary package belongs to (scripts/agents.mjs fetches only the picked agents'), or null.
export const agentOfPackage = (folder) => CATALOG.find((a) => folder.startsWith(a.native))?.id ?? null;
// GET /agents: what a window may know about each agent. No paths, no commands, no adapter package. CAT-1e: short, pick and
// account are the setup wizard's name and lines for it; signIn is its sign-in kind (SIGN_IN_KIND).
export const publicAgents = () => ({ agents: CATALOG.map((a) => ({ id: a.id, name: a.name,
  modes: Object.entries(a.modes).map(([name, m]) => ({ name, tier: m.tier })), start: Object.keys(a.modes).find((k) => a.modes[k].value === a.start),
  auto: a.auto, narrow: Object.keys(a.modes).find((k) => a.modes[k].value === a.narrow), models: a.models, usage: a.usage.reader, short: a.short, pick: a.pick, account: a.account, signIn: a.signIn.kind })) });
