# ACP contracts

What P9's chat (`apps/server/chat.mjs`) may assume about each provider. Carried over from
agent-first-workspace's locked contracts (2026-10-09), where every capability was observed live, and
re-checked in P9 on 2026-10-16 by the recorded turns in `test/fixtures/acp/`.

## Pinned versions

| Package | Version | License | Role |
|---|---|---|---|
| `@agentclientprotocol/sdk` | 2.6.0 | Apache-2.0 | The connection (`apps/server/acp.mjs` wraps it), `ndJsonStream`, schema types for ACP 1 and 2 |
| `@agentclientprotocol/claude-agent-acp` | 0.106.0 | Apache-2.0 | Claude adapter; brings `@anthropic-ai/claude-agent-sdk` 0.3.322 and its bundled Claude Code binary |
| `@agentclientprotocol/codex-acp` | 2.6.0 | Apache-2.0 | Codex adapter; brings `@openai/codex` 0.166.0 |

All three are exact pins in `package.json`. Upgrading one is a deliberate change: record new fixtures
(below), then update this table. `test/acp-contract.test.mjs` fails while a fixture, this table and the
installed package disagree.

## ACP version (0.1.9 O52)

P9 asks both agents for ACP 2 (`ACP_ASK` in `apps/server/chat.mjs`), and falls back to 1 per agent:

- An agent that answers the ask with version 1 is used on 1.
- An agent whose `initialize` fails on the ask for 2 is started once more and asked for 1.
- `P9_ACP_VERSION=1` in the daemon's environment asks every agent for 1. It is the way back if a v2 change
  breaks a chat; ACP 2 is still a draft to its authors.

The rest of `chat.mjs` speaks ACP 1 shapes only. `apps/server/acp-v2.mjs` sits on the wire and turns v2
traffic into v1 in both directions; its header lists every rule (the held `session/prompt` reply, the first
`tool_call_update` becoming a `tool_call`, git-patch diffs, the permission subject, command output, the MCP
server `type`, and what is dropped). On version 1 it passes every line through unchanged.

Seen live on v2 (2026-11-10):

- Codex reports `_meta.steering.supported` in its `initialize` reply and takes `_session/steering` mid-turn
  (`injected`). Claude (0.106.0) has no steering on 2: a message sent mid-turn waits for the turn's end.
- Both agents resume a session through `session/resume`, and send one `idle` state after it.
- Claude's `usage_update` carries `_meta['_claude/rateLimit']` on 2 in the same shape as on 1.
- The account notices (`_auth/*`, `auth/status_update`) carry the account's email; the translator drops them.

## Binaries and auth

Both adapters run their bundled binaries, never the system `claude` or `codex`, and use the user's
existing logins (`~/.claude`, `~/.codex/auth.json`); no `authenticate` call is made. The child gets an
allowlisted environment (`apps/server/child-env.mjs`), so API keys in the daemon's environment never
reach it.

## Rules chat.mjs follows

1. `clientCapabilities = { fs: off, terminal: false, elicitation: { form: {} } }`. Without
   `elicitation.form` both adapters silently skip questions.
2. Codex sessions start in `mode = agent` (Auto review, Codex's own default: writes inside the chat folder
   run, anything else goes to Codex's reviewer instead of asking). The chat's Mode picker offers the
   adapter's four modes by their own names: `read-only`, `workspace-write`, `agent`,
   `agent-full-access` (no sandbox, never asks; threat model row 25). Claude adds `bypassPermissions`.
   The agent lock overrides all of them.
   Claude sessions start in `mode = default` (Manual), set by P9: claude-agent-acp 0.104.1 starts its own
   sessions in `auto`, 0.88.0 in `default` (0.1.9 O51).
   On resume (0.1.9 O32), Codex is set to `agent` and Claude to `default` first, or the lock's mode when the lock is on. Then
   `carry()` puts back the chat's last mode that was not the lock's, so a chat last in `agent-full-access`
   or `bypassPermissions` comes back in it, with no new warning (threat model row 25). With the lock on,
   the mode is left alone. If setting the mode back fails, the chat stays on the mode set first.
3. Stop = `session/close` (800 ms), close stdin (1 s), then `systemctl --user stop` on the session's
   scope, which ends everything in its cgroup, including `setsid` children. Without a user bus, the
   fallback signals the process group, and `setsid` children escape it.
4. The adapter's `sessionId` is stored as the provider session; resume calls `session/resume` with it.
5. A `cancelled` stop reason after a denied approval is normal, not an error.
6. Approval options are the adapter's own (`optionId`, `name`, `kind`); answers are checked against them.
7. After daemon restart, a stored provider session resumes only through `session/resume`.
   An interrupted turn is recorded as interrupted; P9 does not replay the prompt or
   preserve an outstanding approval. An answer for that stale approval is refused.

## Recorded fixtures

`test/fixtures/acp/<provider>.json` holds one real turn with an approval: Claude writes `hello.txt`
(Write tool, `allow-once`); Codex, in `read-only` mode, runs `curl -sI` (`allow_once`). Each records the
adapter version it was captured against. Both are raw ACP 2 traffic, so the replay runs the translator.

To re-record after an upgrade (real logins, a few cents of usage): run a scratch daemon with
`--acp-override test/acp-record.mjs` (`daemon()` in `test/helpers.mjs` takes the argument), drive one turn
with an approval over the daemon's socket the way `test/acp-contract.test.mjs` does (Codex with
`mode: 'Read-only'`: in its default mode it does not ask), then sanitize:

```
node test/acp-sanitize.mjs claude <tmp>/p9-acp-record-claude.jsonl <scratch workspace>
```

The sanitizer drops `_auth/*` and `auth/*` notices, replaces the command list (it carries the user's skills), the
scratch path and the home directory, and redacts email addresses. `gate:all` replays the fixtures through
`test/acp-replay.mjs` with no network.
