# ACP contracts

What P9's chat (`apps/server/chat.mjs`) may assume about each provider. Carried over from
agent-first-workspace's locked contracts (2026-10-09), where every capability was observed live, and
re-checked in P9 on 2026-10-16 by the recorded turns in `test/fixtures/acp/`.

## Pinned versions

| Package | Version | License | Role |
|---|---|---|---|
| `@agentclientprotocol/sdk` | 1.8.0 | Apache-2.0 | `ClientSideConnection`, `ndJsonStream`, schema types. ACP protocol version 1 |
| `@agentclientprotocol/claude-agent-acp` | 0.88.0 | Apache-2.0 | Claude adapter; brings `@anthropic-ai/claude-agent-sdk` 0.3.293 and its bundled Claude Code binary |
| `@agentclientprotocol/codex-acp` | 2.1.1 | Apache-2.0 | Codex adapter; brings `@openai/codex` 0.159.3 |

All three are exact pins in `package.json`. Upgrading one is a deliberate change: record new fixtures
(below), then update this table. `test/acp-contract.test.mjs` fails while a fixture, this table and the
installed package disagree.

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

`test/fixtures/acp/<provider>.json` holds one real turn with an approval answered through the Electron
halo modal: Claude writes `hello.txt` (Write tool, `allow-once`); Codex runs `curl -sI` outside the
sandbox (`allow_once`). Each records the adapter version it was captured against.

To re-record after an upgrade (real logins, a few cents of usage): run a scratch daemon with
`--acp-override test/acp-record.mjs`, drive one turn with an approval through Electron (the project's
private phase 6 evidence script does this), then sanitize:

```
node test/acp-sanitize.mjs claude <tmp>/p9-acp-record-claude.jsonl <scratch workspace>
```

The sanitizer drops `_auth/*` notices, replaces the command list (it carries the user's skills), the
scratch path and the home directory, and redacts email addresses. `gate:all` replays the fixtures through
`test/acp-replay.mjs` with no network.
