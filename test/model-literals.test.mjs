// R8 (O292): model names live in one list, the agent catalog's ladder (apps/server/agents.mjs), so a new quoted model name
// ('opus', "Sonnet 5.5", `gpt-5.1-codex`; any quoted string naming opus, sonnet, haiku, fable or gpt-N) anywhere else in
// the app, its scripts or its tests fails here. The counts below are what was there on 2026-11-28; a file's count must
// match: one more is a new name (read it from the catalog, or from a fixture's own recorded header), one fewer means lower
// the number here, so the list only shrinks. Tests count too: they are what pins the names (PIPELINE-FIXES-0.1.9.md § R8).
// Comments are not counted. Same shape as test/agent-literals.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './helpers.mjs';

const ALLOW = {
  // App: the price table (one row per model id), the new-session menu's and the model picker's sample models.
  'apps/server/usage-turns.mjs': 5, 'apps/web/src/chat-view.mjs': 2, 'apps/web/src/controller.mjs': 2,
  // Tests and the recorded agent fixtures, as of 2026-11-28.
  'test/acp-v2.test.mjs': 2, 'test/chat-bar.test.mjs': 99, 'test/chat-o267.test.mjs': 41, 'test/chat.test.mjs': 57,
  'test/delegate-schedule.test.mjs': 1, 'test/delegate-window.test.mjs': 8, 'test/delegate.test.mjs': 22,
  'test/fake-acp-agent.mjs': 10, 'test/fake-acp-v2-agent.mjs': 2, 'test/mc16-phone-default.test.mjs': 12,
  'test/mission-checklist.test.mjs': 1, 'test/model-lists.test.mjs': 27, 'test/o214-v2-delivered.test.mjs': 2,
  'test/o274-small-fixes.test.mjs': 2, 'test/phone-parity.test.mjs': 65, 'test/phone-projects.test.mjs': 3,
  'test/phone.test.mjs': 4, 'test/profiles.test.mjs': 5, 'test/projects-page.test.mjs': 8,
  'test/queued-messages.test.mjs': 2, 'test/ready-row.test.mjs': 1, 'test/sample-data.mjs': 4,
  'test/script-say.test.mjs': 3, 'test/settings-chats.test.mjs': 12, 'test/sprint-card.test.mjs': 3,
  'test/sprint-done-merged.test.mjs': 1, 'test/sprint-hooks.test.mjs': 45, 'test/sprint-lead-start.test.mjs': 2,
  'test/sprint-owner-v.test.mjs': 3, 'test/sprint-pause.test.mjs': 10, 'test/sprint-role-title-window.test.mjs': 1,
  'test/sprint-role-title.test.mjs': 1, 'test/sprint-setup-framing.test.mjs': 3,
  'test/sprint-setup-seen.test.mjs': 2, 'test/sprint-start.test.mjs': 45, 'test/sprint.test.mjs': 6,
  'test/telemetry.test.mjs': 11, 'test/usage-pace.test.mjs': 2, 'test/usage-tabs.test.mjs': 11,
  'test/usage-turns.test.mjs': 34, 'test/work-queue.test.mjs': 20, 'test/worker-repick.test.mjs': 6,
  'test/worker-window.test.mjs': 2, 'test/fixtures/acp/claude.json': 84, 'test/fixtures/acp/codex.json': 44,
};
// ponytail: a count per file, not per line, so a name moved inside an allowed file passes; the count still stops a new one.
// A quote right after a letter or a backslash is an apostrophe (today's, Fable\'s), not the start of a string.
const LITERAL = /(?<![\w\\])(['"`])[^'"`\n]*?\b(?:(?:opus|sonnet|haiku|fable)\b|gpt-\d)[^'"`\n]*?\1/gi;
const SOURCE = /\.(?:mjs|cjs|js|ts|tsx|astro|html|json|jsonl)$/;
const SELF = 'test/model-literals.test.mjs';

export function modelCounts(files, read) {
  const counts = {};
  for (const file of files) {
    if (!SOURCE.test(file) || file === 'apps/server/agents.mjs' || file === SELF || file.split('/').some((part) => part === 'dist' || part === 'node_modules')) continue;
    const n = (read(file).match(LITERAL) ?? []).length;
    if (n) counts[file] = n;
  }
  return counts;
}
export function modelProblems(counts, allow = ALLOW) {
  const problems = [];
  for (const file of new Set([...Object.keys(counts), ...Object.keys(allow)])) {
    const n = counts[file] ?? 0, kept = allow[file] ?? 0;
    if (n > kept) problems.push(`${file}: ${n} quoted model names, ${kept} allowed: read the model from apps/server/agents.mjs or the fixture`);
    else if (n < kept) problems.push(`${file}: ${n} quoted model names, ${kept} allowed: lower its number in ${SELF}`);
  }
  return problems;
}

test('R8: no new quoted model name outside the agent catalog, in the app or its tests', () => {
  // A walk, not git ls-files: the dev space's copy has no .git.
  const files = ['apps', 'packages', 'scripts', 'test'].flatMap((top) => readdirSync(path.join(root, top), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile()).map((d) => path.relative(root, path.join(d.parentPath, d.name)).split(path.sep).join('/')));
  assert.deepEqual(modelProblems(modelCounts(files, (f) => readFileSync(path.join(root, f), 'utf8'))), []);
});

test('R8: the check counts a quoted model name in any quote and case, not a comment, the catalog or a longer word', () => {
  const text = {
    'apps/server/new.mjs': "pick('opus'); const m = \"Sonnet 5.5\", c = `gpt-5.1-codex`;\n// a comment naming haiku and fable",
    'test/a.test.mjs': "model: 'claude-haiku-5-5', note: 'fables and opuses are words', 'gpt-x', // today's opus, Fable\\'s",
    'test/fixtures/acp/x.json': '{"model":"fable"}', 'apps/server/agents.mjs': "ladder: ['haiku', 'opus']", 'apps/web/dist/b.js': "'opus'",
  };
  const counts = modelCounts([...Object.keys(text), 'README.md'], (f) => text[f]);
  assert.deepEqual(counts, { 'apps/server/new.mjs': 3, 'test/a.test.mjs': 1, 'test/fixtures/acp/x.json': 1 });
  const problems = modelProblems(counts, { 'test/a.test.mjs': 1, 'test/fixtures/acp/x.json': 2, 'test/gone.test.mjs': 4 });
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems[0], /^apps\/server\/new\.mjs: 3 .* 0 allowed: read the model/);
  assert.match(problems[1], /^test\/fixtures\/acp\/x\.json: 1 .* 2 allowed: lower its number/);
  assert.match(problems[2], /^test\/gone\.test\.mjs: 0 .* 4 allowed: lower/);
});
