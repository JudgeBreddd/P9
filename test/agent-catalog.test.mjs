// CAT-1: the agent catalog. The server's per-agent tables now read from apps/server/agents.mjs; each must hold the
// values the literal tables held before the switch, and GET /agents serves the catalog without paths or commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CATALOG, MODES, TIER, NARROW, START, AUTO, LOGIN, COMMANDS, PASS, SIGNED_OUT, WHY, SIGN_IN } from '../apps/server/agents.mjs';
import { AGENTS, dependencies } from '../apps/server/deps.mjs';
import { adapterEntry } from '../apps/server/chat.mjs';
import { ROUTES } from '../packages/protocol/index.mjs';
import { daemon, http, authenticated } from './helpers.mjs';

// The literal tables on main before CAT-1, copied verbatim (deps.mjs, chat.mjs, delegate.mjs, server.mjs, setup-routes.mjs).
const BEFORE = {
  AGENTS: ['claude', 'codex'],
  PASS: { claude: ' --cli', codex: '' },
  MODES: { claude: { Auto: 'auto', Manual: 'default', Plan: 'plan', 'Accept edits': 'acceptEdits', 'Bypass permissions': 'bypassPermissions' },
    codex: { 'Read-only': 'read-only', 'Workspace access': 'workspace-write', 'Auto review': 'agent', 'Full access': 'agent-full-access' } },
  TIER: { claude: { Plan: 0, Manual: 1, 'Accept edits': 2, Auto: 3, 'Bypass permissions': 4 },
    codex: { 'Read-only': 0, 'Workspace access': 2, 'Auto review': 3, 'Full access': 4 } },
  NARROW: { claude: 'plan', codex: 'read-only' },
  START: { claude: 'default', codex: 'agent' },
  AUTO: { claude: 'Auto', codex: 'Auto review' },
  LOGIN: { claude: ['--cli', 'auth', 'login', '--claudeai'], codex: ['cli', 'login', '--device-auth'] },
  COMMANDS: { claude: { login: 'claude auth login' }, codex: { login: 'codex login' } },
  SIGNED_OUT: { claude: 'Claude Code is not signed in on this computer. Sign in from Settings → Setup in the desktop app, or open a terminal, run claude and log in. Then start a new chat.',
    codex: 'Codex is not signed in on this computer. Sign in from Settings → Setup in the desktop app, or open a terminal and run codex login. Then start a new chat.' },
  WHY: { claude: 'Claude Code, for Claude chats and a terminal.', codex: 'Codex, for Codex chats and a terminal.' },
  SIGN_IN: { claude: ['claudeDir', '.credentials.json'], codex: ['codexHome', 'auth.json'] },
  ADAPTER: { claude: 'claude-agent-acp', codex: 'codex-acp' },
};

test('CAT-1: every server table read from the catalog holds the value its literal held, for claude and codex', async () => {
  assert.deepEqual(AGENTS, BEFORE.AGENTS);
  assert.deepEqual(CATALOG.map((a) => a.id), BEFORE.AGENTS);
  for (const [name, table] of Object.entries({ PASS, MODES, NARROW, START, AUTO, LOGIN, COMMANDS, SIGNED_OUT, WHY })) assert.deepEqual(table, BEFORE[name], name);
  // Key order too: delegate.mjs lists the modes in TIER's order in a refusal, chat.mjs in MODES's order.
  for (const id of AGENTS) {
    assert.deepEqual(Object.entries(TIER[id]), Object.entries(BEFORE.TIER[id]), 'TIER ' + id);
    assert.deepEqual(Object.keys(MODES[id]), Object.keys(BEFORE.MODES[id]), 'MODES ' + id);
    assert.deepEqual([SIGN_IN[id].dir, SIGN_IN[id].file], BEFORE.SIGN_IN[id], 'SIGN_IN ' + id);
    assert.equal(adapterEntry(id).split(path.sep).join('/').endsWith(`/@agentclientprotocol/${BEFORE.ADAPTER[id]}/dist/index.js`), true, 'adapter ' + id);
  }
  const agents = (await dependencies({ platform: 'darwin', env: {}, home: '/nonexistent' })).filter((d) => AGENTS.includes(d.id));
  assert.deepEqual(agents.map((d) => [d.id, d.why]), AGENTS.map((id) => [id, BEFORE.WHY[id]]));
  assert.equal(Object.isFrozen(CATALOG) && CATALOG.every((a) => Object.isFrozen(a) && Object.isFrozen(a.modes)), true);
});

test('CAT-1: GET /agents through a real daemon serves each agent, its modes and tiers, and no path or command', async (t) => {
  assert.ok(ROUTES.includes('/agents'));
  const instance = await daemon(t);
  const socketPath = path.join(instance.state, 'daemon.sock');
  assert.equal((await http({ socketPath, route: '/agents' })).status, 401);
  const answer = await http({ socketPath, route: '/agents', headers: authenticated(instance.credentials) });
  assert.equal(answer.status, 200);
  const { agents } = JSON.parse(answer.text);
  assert.deepEqual(agents.map((a) => [a.id, a.name]), [['claude', 'Claude Code'], ['codex', 'Codex']]);
  for (const a of agents) {
    assert.deepEqual(a.modes.map((m) => [m.name, m.tier]), Object.keys(BEFORE.MODES[a.id]).map((name) => [name, BEFORE.TIER[a.id][name]]));
    assert.deepEqual([a.start, a.auto, a.narrow], { claude: ['Manual', 'Auto', 'Plan'], codex: ['Auto review', 'Auto review', 'Read-only'] }[a.id]);
  }
  for (const secret of ['.credentials.json', 'auth.json', 'login', '--cli', 'claude-agent-acp', 'codex-acp', 'claudeDir', 'codexHome']) assert.equal(answer.text.includes(secret), false, secret);
});
