// R8 (O292): model names live in one list, the agent catalog's ladder (apps/server/agents.mjs), so a new string naming a
// model ('opus', "Sonnet 5.5", `gpt-5.1-codex`; the rule is at NAME below) anywhere else in the app, its scripts or its
// tests fails here. The counts below are what was there on 2026-11-28; a file's count must
// match: one more is a new name (read it from the catalog, or from a fixture's own recorded header), one fewer means lower
// the number here, so the list only shrinks. Tests count too: they are what pins the names (PIPELINE-FIXES-0.1.9.md § R8).
// Comments are not counted: code is read by the TypeScript parser. Same shape as test/agent-literals.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { root } from './helpers.mjs';

const ALLOW = {
  // App: the price table (one row per model id), the new-session menu's and the model picker's sample models, and the
  // delegate tool's description ("such as Fable's").
  'apps/server/delegate.mjs': 1, 'apps/server/usage-turns.mjs': 5, 'apps/web/src/chat-view.mjs': 2,
  'apps/web/src/controller.mjs': 2,
  // Tests and the recorded agent fixtures, as of 2026-11-28.
  'test/acp-v2.test.mjs': 2, 'test/chat-bar.test.mjs': 99, 'test/chat-o267.test.mjs': 41, 'test/chat.test.mjs': 64,
  'test/delegate-schedule.test.mjs': 1, 'test/delegate-window.test.mjs': 9, 'test/delegate.test.mjs': 19,
  'test/fake-acp-agent.mjs': 10, 'test/fake-acp-v2-agent.mjs': 2, 'test/mc16-phone-default.test.mjs': 12,
  'test/mission-checklist.test.mjs': 1, 'test/model-lists.test.mjs': 28, 'test/o214-v2-delivered.test.mjs': 2,
  'test/o274-small-fixes.test.mjs': 2, 'test/phone-parity.test.mjs': 65, 'test/phone-projects.test.mjs': 3,
  'test/phone.test.mjs': 4, 'test/profiles.test.mjs': 5, 'test/projects-page.test.mjs': 8,
  'test/queued-messages.test.mjs': 2, 'test/ready-row.test.mjs': 1, 'test/sample-data.mjs': 4,
  'test/script-say.test.mjs': 3, 'test/settings-chats.test.mjs': 12, 'test/sprint-card.test.mjs': 3,
  'test/sprint-done-merged.test.mjs': 1, 'test/sprint-hooks.test.mjs': 45, 'test/sprint-lead-start.test.mjs': 2,
  'test/sprint-owner-v.test.mjs': 3, 'test/sprint-pause.test.mjs': 10, 'test/sprint-role-title-window.test.mjs': 1,
  'test/sprint-role-title.test.mjs': 1, 'test/sprint-setup-framing.test.mjs': 3,
  'test/sprint-setup-seen.test.mjs': 2, 'test/sprint-start.test.mjs': 48, 'test/sprint.test.mjs': 6,
  'test/telemetry.test.mjs': 11, 'test/usage-pace.test.mjs': 2, 'test/usage-tabs.test.mjs': 11,
  'test/usage-turns.test.mjs': 33, 'test/work-queue.test.mjs': 26, 'test/worker-repick.test.mjs': 6,
  'test/worker-window.test.mjs': 2, 'test/fixtures/acp/claude.json': 84, 'test/fixtures/acp/codex.json': 44,
};
// ponytail: a count per file, not per line, so a name moved inside an allowed file passes; the count still stops a new one.
// A model name: any gpt-N, or opus, sonnet, haiku or fable as a whole word in any case, each one counted (two in one string
// count two). No word rule tells the poem from the model ("write a sonnet" counts): a string that is not a model raises its
// file's number below, with a comment saying so, in review.
const NAME = /\bgpt-\d|\b(?:opus|sonnet|haiku|fable)\b/gi;
// Only what can be read exactly: code through the TypeScript parser and JSON through JSON.parse. Shell, PowerShell, HTML, CSS
// and YAML are not read; on 2026-11-28 none of them held a model name outside a comment.
const CODE = /\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx)$/, JSON_FILE = /\.jsonl?$/;
// Files with no name in their raw text are not parsed; a \u escape could spell one, so those are parsed too.
const MAYBE = /opus|sonnet|haiku|fable|gpt-\d|\\u/i;
const SELF = 'test/model-literals.test.mjs';

// The strings in a code file: string literals, template parts and JSX text, as node reads them, so comments and regex
// literals are never strings and an apostrophe, an escaped quote or a multiline template is read right.
function codeStrings(file, text) {
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false));
  return out;
}
// The keys and string values of a JSON file: one document, or else one record per line (JSONL, or a .json written that way).
function jsonStrings(file, text) {
  let records;
  try { records = file.endsWith('.jsonl') ? null : [JSON.parse(text)]; } catch { records = null; }
  records ??= text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v)) out.push(k); walk(x); }
  };
  records.forEach(walk);
  return out;
}

export function modelCounts(files, read) {
  const counts = {};
  for (const file of files) {
    if (!(CODE.test(file) || JSON_FILE.test(file)) || file === 'apps/server/agents.mjs' || file === SELF
      || file.split('/').some((part) => part === 'dist' || part === 'node_modules')) continue;
    const text = read(file);
    if (!MAYBE.test(text)) continue;
    const n = (CODE.test(file) ? codeStrings(file, text) : jsonStrings(file, text)).reduce((sum, x) => sum + (x.match(NAME)?.length ?? 0), 0);
    if (n) counts[file] = n;
  }
  return counts;
}
export function modelProblems(counts, allow = ALLOW) {
  const problems = [];
  for (const file of new Set([...Object.keys(counts), ...Object.keys(allow)])) {
    const n = counts[file] ?? 0, kept = allow[file] ?? 0;
    if (n > kept) problems.push(`${file}: ${n} model names, ${kept} allowed: read the model from apps/server/agents.mjs or the fixture (not a model, such as a poem: raise the number here and say so)`);
    else if (n < kept) problems.push(`${file}: ${n} model names, ${kept} allowed: lower its number in ${SELF}`);
  }
  return problems;
}

test('R8: no new model name outside the agent catalog, in the app or its tests', () => {
  // A walk, not git ls-files: the dev space's copy has no .git.
  const files = ['apps', 'packages', 'scripts', 'test'].flatMap((top) => readdirSync(path.join(root, top), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile()).map((d) => path.relative(root, path.join(d.parentPath, d.name)).split(path.sep).join('/')));
  assert.deepEqual(modelProblems(modelCounts(files, (f) => readFileSync(path.join(root, f), 'utf8'))), []);
});

test('R8: the check counts a model name in any quote and case, not a comment, the catalog or a longer word', () => {
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

test('R8 review B1: a comment or a regex literal is not a string; a poem word still counts', () => {
  const text = {
    'apps/server/c.mjs': [
      '// use "claude-opus-5-5" in the repro', '/* model: "claude-opus-5-5" */', 'const re = /"opus"/;',
      "const real = 'claude-fable-5-2', poem = 'Write a sonnet';",
    ].join('\n'),
  };
  assert.deepEqual(modelCounts(Object.keys(text), (f) => text[f]), { 'apps/server/c.mjs': 2 });
});

test('R8 review B2: an apostrophe, an escaped quote or a multiline template does not hide a model name', () => {
  const text = {
    'apps/server/a.mjs': "const s = \"Use Claude Opus when it's available\";",
    'apps/server/e.mjs': 'const s = "pick \\"claude-opus-5-5\\" first";',
    'apps/server/t.mjs': 'const s = `first line\nmodel: claude-opus-5-5\n`;',
    'apps/web/src/v.tsx': 'export const V = () => <span title="x">Sonnet 5.5</span>;',
  };
  assert.deepEqual(modelCounts(Object.keys(text), (f) => text[f]),
    { 'apps/server/a.mjs': 1, 'apps/server/e.mjs': 1, 'apps/server/t.mjs': 1, 'apps/web/src/v.tsx': 1 });
});

test('R8 review r2: a name after an article, a second name in one string, JSONL records and an escaped name all count', () => {
  const text = {
    'apps/web/src/copy.json': '{"copy":"Use a Sonnet 5.5 model"}',
    'apps/server/two.mjs': "const c = 'config:model=opus,fallback=sonnet';",
    'test/fixtures/r.jsonl': '{"model":"opus"}\n{"model":"sonnet","fallback":"haiku"}\n',
    'test/fixtures/r.json': '{"model":"opus"}\n{"model":"sonnet","fallback":"haiku"}\n',
    'test/fixtures/u.json': '{"model":"claude-\\u006fpus-5-5"}',
  };
  assert.deepEqual(modelCounts(Object.keys(text), (f) => text[f]), {
    'apps/web/src/copy.json': 1, 'apps/server/two.mjs': 2, 'test/fixtures/r.jsonl': 3, 'test/fixtures/r.json': 3, 'test/fixtures/u.json': 1,
  });
});

test('R8 review r2: only code and JSON are read; a shell, CSS or HTML file is out of scope', () => {
  const text = { 'scripts/x.sh': 'MODEL="claude-opus-5-5" # fable', 'apps/web/src/s.css': '.status-opus { }', 'apps/web/a.html': '<b>Opus</b>' };
  assert.deepEqual(modelCounts(Object.keys(text), (f) => text[f]), {});
});
