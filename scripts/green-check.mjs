#!/usr/bin/env node
// The mechanical green check (the owner, 2026-11-13: "Whatever tests the user and the agent agree on are the tests that have to
// be green"). A plan item names its agreed tests in a last clause, `Tests: <file>::<title words> | <file>::<title words>`
// (the format is in the plan template, apps/server/sprint-files.mjs). Before a merge this script checks, for the item's
// commit, that CI is complete and green and that each named test has exactly one passed line from its own file and no
// failed (✖) line in the CI job logs. The passed lines are the "P9_PASS <file> :: <title>" lines test/file-limit.mjs (the CI
// Tests line's reporter) writes for each test that ran and passed; a skipped or todo test writes none, and spec's ✔ lines,
// which carry no file, are not read. Anything it cannot read (no item, no Tests clause, a selector not "file::title", gh
// failing, more runs or jobs than one page, a missing log, a log with no P9_PASS lines, a title matching no line or more
// than one) refuses: exit 1, and the last line names what is missing. It never passes by default.
//
// As a sprint script (hooks.json: point before-merge, blocking: true): P9 gives the sprint's state on stdin and runs it in
// the sprint folder; the item and commit come from the lead's sprint_event subject (subject.item, subject.commit; without a
// commit, the item's review record), the plan from sprint.md there, the repository from the project's Clone from.
// By hand: node scripts/green-check.mjs --item O7 --commit <sha> --repo owner/name [--plan sprint.md]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const refuse = (why) => { console.log('green check refused: ' + why); process.exit(1); };
const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
// ponytail: gh does the GitHub calls (its own sign-in); a host without gh refuses, which is the safe side.
const gh = (route) => { try { return execFileSync('gh', ['api', route], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { refuse(`gh api ${route.split('?')[0]} failed (${String(e.stderr || e.message).trim().split('\n').at(-1) || 'no output'})`); } };
const json = (route) => { const text = gh(route); try { return JSON.parse(text); } catch { refuse(`gh api ${route.split('?')[0]} gave no JSON`); } };

// The named tests: the text after the item's last "Tests:", split on " | ", each "file::title words". A selector that is
// not a test file path and a title (empty, no "::", an empty side) comes back as { bad } for the caller to refuse.
export function namedTests(row) {
  const at = row.lastIndexOf('Tests:');
  if (at < 0) return null;
  const all = row.slice(at + 'Tests:'.length).trim();
  return all ? all.split(' | ').map((t) => {
    const k = t.indexOf('::'), file = t.slice(0, k).trim(), title = t.slice(k + 2).trim();
    return k > 0 && /^[\w./-]+\.test\.[cm]?js$/.test(file) && title ? { file, title } : { bad: t.trim() };
  }) : [];
}
// The plan line of an item: "- [ ] <id>: ...", the id as planItems reads it (its text before the first colon).
export function rowOf(plan, item) {
  return plan.split('\n').map((l) => /^\s*- \[[ xX]\] (.+)$/.exec(l)?.[1].trim()).find((t) => t && t.split(':')[0].trim() === item) ?? null;
}
// P9_PASS lines (file and title of a test that passed) and ✖ lines (spec's or file-limit's), without the log's timestamp
// and spec's "(12.3ms)".
export function results(log) {
  const out = [];
  for (const line of log.split('\n')) {
    const pass = /^(?:\S+Z )?P9_PASS (\S+) :: (.+?)\s*$/.exec(line), fail = /^(?:\S+Z )?\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/.exec(line);
    if (pass) out.push({ ok: true, file: pass[1], title: pass[2] });
    else if (fail) out.push({ ok: false, title: fail[1] });
  }
  return out;
}

async function main() {
  let state = null;
  if (!process.argv.includes('--item')) {
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    try { state = JSON.parse(input); } catch { refuse('no sprint state on stdin and no --item'); }
  }
  const item = arg('item') ?? state?.subject?.item;
  if (!item) refuse('no item: the lead\'s sprint_event before-merge must pass subject.item (the plan item being merged)');
  const commit = arg('commit') ?? state?.subject?.commit ?? state?.items?.find((i) => i.id === item)?.review?.commit;
  if (!commit || !/^[0-9a-f]{7,40}$/.test(commit)) refuse(`item ${item}: no commit (pass subject.commit, or let the item's review record carry one)`);
  const source = arg('repo') ?? state?.project?.source ?? '';
  const repo = /^[\w.-]+\/[\w.-]+$/.test(source) ? source : /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(source)?.[1];
  if (!repo) refuse(`item ${item}: no GitHub repository (the project's Clone from, or --repo owner/name)`);
  const planFile = arg('plan') ?? (state?.sprint?.folder ? path.join(state.sprint.folder, 'sprint.md') : 'sprint.md');
  let plan; try { plan = readFileSync(planFile, 'utf8'); } catch { refuse(`item ${item}: cannot read the plan (${path.basename(planFile)})`); }
  const row = rowOf(plan, item);
  if (!row) refuse(`item ${item}: not in the plan`);
  const tests = namedTests(row);
  if (!tests?.length) refuse(`item ${item}: names no agreed tests (add a last clause "Tests: <file>::<title words> | ..." to its plan line)`);
  const bad = tests.find((t) => t.bad !== undefined);
  if (bad) refuse(`item ${item}: Tests selector "${bad.bad}" is not <test file>::<title words>`);

  // ponytail: one page of 100; more refuses rather than reading part of CI.
  const page = (route, key) => { const r = json(route), list = r[key] ?? [];
    if ((r.total_count ?? 0) > list.length) refuse(`item ${item}: ${route.split('?')[0]} has ${r.total_count} ${key}, more than one page of ${list.length}`);
    return list; };
  // C3 (O288), #574 r2-r4: every run on the commit must be complete and green, from any PR or event, except a run by hand
  // (workflow_dispatch: named files, bare, evidence), which diagnoses and is not the commit's CI. A cancelled run is not
  // green: marking a draft ready while its run is still going cancels it, and a re-run (same id, latest attempt) clears it.
  const runs = page(`repos/${repo}/actions/runs?head_sha=${commit}&per_page=100`, 'workflow_runs').filter((r) => r.event !== 'workflow_dispatch');
  if (!runs.length) refuse(`item ${item}: no CI run on ${commit.slice(0, 8)}`);
  const open = runs.filter((r) => r.status !== 'completed'), red = runs.filter((r) => r.status === 'completed' && r.conclusion !== 'success');
  if (open.length) refuse(`item ${item}: CI on ${commit.slice(0, 8)} is not complete (${open.map((r) => r.name).join(', ')})`);
  if (red.length) refuse(`item ${item}: CI on ${commit.slice(0, 8)} is not green (${red.map((r) => r.name + ' ' + r.conclusion).join(', ')})${red.some((r) => r.conclusion === 'cancelled') ? '; re-run it: ' + red.filter((r) => r.conclusion === 'cancelled').map((r) => `gh run rerun ${r.id} -R ${repo}`).join(' and ') : ''}`);
  const seen = [];
  for (const r of runs) for (const j of page(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`, 'jobs')) {
    // C1 (O286): the quarantine shard is advisory (it never blocks), so its lines are no evidence either way.
    if (j.conclusion === 'skipped' || / \(quarantine\)$/.test(j.name)) continue;
    const log = gh(`repos/${repo}/actions/jobs/${j.id}/logs`);
    if (!log.trim()) refuse(`item ${item}: the log of CI job "${j.name}" is empty`);
    seen.push(...results(log).map((s) => ({ ...s, job: j.id })));
  }
  if (!seen.some((s) => s.ok)) refuse(`item ${item}: the CI logs on ${commit.slice(0, 8)} have no P9_PASS lines (the per-test file evidence test/file-limit.mjs writes)`);
  for (const t of tests) {
    const name = t.file + '::' + t.title;
    // ponytail: a ✖ line has no file, so a failure of the same title in any file refuses; the safe side.
    const hits = seen.filter((s) => s.title.includes(t.title)), ok = hits.filter((s) => s.ok && s.file === t.file), bad = hits.filter((s) => !s.ok);
    if (bad.length) refuse(`item ${item}: ${name} failed in CI (${bad.length} ✖ line${bad.length > 1 ? 's' : ''})`);
    if (!ok.length) refuse(`item ${item}: ${name} has no passed line in CI on ${commit.slice(0, 8)}`);
    // #574 r4-r5: one name must pick one test: one title across all jobs, and one line per job. The same test in two runs
    // (a reopened PR) or on two platforms is still one test.
    const titles = new Set(ok.map((s) => s.title));
    if (titles.size > 1) refuse(`item ${item}: ${name} matches ${titles.size} passed tests; name it so it matches exactly one`);
    const most = Math.max(...Object.values(Object.groupBy(ok, (s) => s.job)).map((l) => l.length));
    if (most > 1) refuse(`item ${item}: ${name} matches ${most} passed lines in one CI job; name it so it matches exactly one`);
  }
  console.log(`green: item ${item}, ${tests.length} named test${tests.length > 1 ? 's' : ''} passed in CI on ${commit.slice(0, 8)}`);
}
if (import.meta.url === 'file://' + process.argv[1] || process.argv[1]?.endsWith('green-check.mjs')) await main();
