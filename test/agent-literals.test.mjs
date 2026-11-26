// CAT-1j build check: the agents P9 runs come from apps/server/agents.mjs (the catalog), so a new 'claude' or 'codex'
// string anywhere else in the app or its scripts fails here. The count of each file below is what was left when CAT-1
// was done, each for the reason given: one agent's own behaviour (its files, its sign-in, its adapter's extras) or a
// web file whose bytes the startup budget keeps for now. A file's count must match: one more is a new literal (read
// the catalog instead); one fewer means lower the number here, so the list only shrinks. Tests are not checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './helpers.mjs';

const ALLOW = {
  // Claude-only: profiles run on Claude, its compact window, raw SDK messages, the handoff to Remote Control, its live
  // rate-limit reading, its poll and transcript folder; Codex-only: its rollout files, its usage app-server and CLI path.
  'apps/server/chat.mjs': 11, 'apps/server/delegate.mjs': 5, 'apps/server/server.mjs': 3, 'apps/server/move.mjs': 6,
  'apps/server/claude-usage.mjs': 2, 'apps/server/codex-usage.mjs': 2, 'apps/server/deps.mjs': 1,
  // Saved shapes: the telemetry table's CHECK and the memory index's provider field; the setup wizard's claudeCli/codexCli answer.
  'apps/server/telemetry.mjs': 4, 'apps/server/memory.mjs': 2, 'apps/server/setup-routes.mjs': 2,
  // Web: the sample view's two agents, pet roles, Claude-only buttons (handoff, cache timer) and the remote-install
  // checkboxes; moving them to GET /agents costs startup bytes (CAT-2).
  'apps/web/src/chat-view.mjs': 10, 'apps/web/src/phone.ts': 12, 'apps/web/src/shell-start.ts': 7, 'apps/web/src/controller.mjs': 5,
  'apps/web/src/settings-view.mjs': 4, 'apps/web/src/cards-modal.mjs': 2, 'apps/web/src/onboarding.mjs': 2,
  'apps/web/src/helpers.mjs': 1, 'apps/web/src/mission-view.mjs': 1, 'apps/web/src/sprint-view.mjs': 1,
};
// ponytail: a count per file, not per line, so a literal moved inside an allowed file passes; the count still stops a new one.
const LITERAL = /(['"`])(?:claude|codex)\1/g;
const SOURCE = /\.(?:mjs|cjs|js|ts|tsx|astro|html)$/;

export function literalCounts(files, read) {
  const counts = {};
  for (const file of files) {
    if (!SOURCE.test(file) || file === 'apps/server/agents.mjs' || file.split('/').some((part) => part === 'dist' || part === 'node_modules')) continue;
    const n = (read(file).match(LITERAL) ?? []).length;
    if (n) counts[file] = n;
  }
  return counts;
}
export function literalProblems(counts, allow = ALLOW) {
  const problems = [];
  for (const file of new Set([...Object.keys(counts), ...Object.keys(allow)])) {
    const n = counts[file] ?? 0, kept = allow[file] ?? 0;
    if (n > kept) problems.push(`${file}: ${n} 'claude'/'codex' strings, ${kept} allowed: read the agent from apps/server/agents.mjs`);
    else if (n < kept) problems.push(`${file}: ${n} 'claude'/'codex' strings, ${kept} allowed: lower its number in test/agent-literals.test.mjs`);
  }
  return problems;
}

test('CAT-1j: no new claude or codex string outside the agent catalog', () => {
  // A walk, not git ls-files: the dev space's copy has no .git. Built and installed folders are skipped by literalCounts.
  const files = ['apps', 'packages', 'scripts'].flatMap((top) => readdirSync(path.join(root, top), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile()).map((d) => path.relative(root, path.join(d.parentPath, d.name)).split(path.sep).join('/')));
  assert.deepEqual(literalProblems(literalCounts(files, (f) => readFileSync(path.join(root, f), 'utf8'))), []);
  console.log('PASS CAT-1j literals: every claude/codex string outside agents.mjs is on the allow-list, at its count');
});

test('CAT-1j: the check catches a new string in any quote, in a new file or an allowed one, and a removed one', () => {
  const read = (f) => ({ 'apps/server/new.mjs': "if (p === 'codex') x();", 'apps/web/src/a.ts': 'const a = "claude", b = `codex`;',
    'apps/server/ok.mjs': "provider === 'claudette' || 'claude-code' || claude", 'apps/server/agents.mjs': "id: 'claude'", 'apps/web/dist/x.js': "'claude'", 'apps/web/node_modules/y.js': "'codex'" })[f];
  const counts = literalCounts(['apps/server/new.mjs', 'apps/web/src/a.ts', 'apps/server/ok.mjs', 'apps/server/agents.mjs', 'apps/web/dist/x.js', 'apps/web/node_modules/y.js', 'README.md'], read);
  assert.deepEqual(counts, { 'apps/server/new.mjs': 1, 'apps/web/src/a.ts': 2 }, 'longer names, bare words, the catalog, built and installed files are not counted');
  const problems = literalProblems(counts, { 'apps/web/src/a.ts': 1, 'apps/server/gone.mjs': 2 });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^apps\/server\/new\.mjs: 1 .* 0 allowed: read the agent/);
  assert.match(problems[1], /^apps\/web\/src\/a\.ts: 2 .* 1 allowed: read the agent/);
  assert.match(problems[2], /^apps\/server\/gone\.mjs: 0 .* 2 allowed: lower its number/);
  console.log('PASS CAT-1j literals check: a new string in a new or allowed file is refused, a removed one asks for a lower number');
});
